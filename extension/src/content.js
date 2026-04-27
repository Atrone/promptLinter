/**
 * Prompt linter content script utilities.
 * This file handles prompt extraction and analysis rendering on the active page.
 */
(function promptLinterContentScript() {
  const MIN_AUTODETECT_PROMPT_LENGTH = 20;
  const AUTODETECT_DEBOUNCE_MS = 700;
  const CHATGPT_EXTRACT_POLL_INTERVAL_MS = 5000;
  let promptDetectionTimer = null;
  let lastDetectedPromptText = "";
  let chatGptPollInProgress = false;

  /**
   * Reads currently selected page text.
   * @returns {string} Trimmed selected text.
   */
  function getSelectedText() {
    // Extract highlighted text to support quick linting from arbitrary content.
    var selection = window.getSelection();
    if (!selection) {
      return "";
    }
    return String(selection.toString() || "").trim();
  }

  /**
   * Build a safe unique selector path for an element.
   * @param {Element} element - Element to resolve.
   * @returns {string} CSS-like path string.
   */
  function getElementPath(element) {
    // Stop early for invalid nodes.
    if (!element || !element.nodeType || element.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    // Traverse up and construct a stable-ish path.
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && segments.length < 8) {
      // Prefer ID selector when available.
      if (current.id) {
        segments.unshift(`${current.tagName.toLowerCase()}#${current.id}`);
        break;
      }

      // Capture nth-of-type to distinguish sibling fields.
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName)
        : [];
      const index = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
      segments.unshift(`${tag}${index}`);
      current = current.parentElement;
    }

    // Join the path for diagnostics.
    return segments.join(" > ");
  }

  /**
   * Gather candidate prompt text entries from form fields and editor-like elements.
   * @returns {Array<{selector: string, source: string, text: string}>} Prompt candidates.
   */
  function collectPromptCandidates() {
    // Select common input sources where prompts are authored.
    const fieldSelectors = [
      "textarea",
      "input[type='text']",
      "input[type='search']",
      "[contenteditable='true']",
      "[role='textbox']"
    ];
    const elements = Array.from(document.querySelectorAll(fieldSelectors.join(",")));

    // Normalize candidate payloads while filtering short noise.
    const candidates = elements
      .map((element) => {
        const rawText =
          element.matches("textarea, input") ? element.value || "" : element.textContent || "";
        const text = rawText.trim();
        return {
          selector: getElementPath(element),
          source: element.tagName.toLowerCase(),
          text
        };
      })
      .filter((candidate) => candidate.text.length >= 10);

    // De-duplicate by exact content to avoid repeated mirrored editors.
    const seen = new Set();
    return candidates.filter((candidate) => {
      // Track exact text values.
      if (seen.has(candidate.text)) {
        return false;
      }
      seen.add(candidate.text);
      return true;
    });
  }

  /**
   * Checks whether text looks long enough to be an authored prompt.
   * @param {string} text - Candidate text from an editable field.
   * @returns {boolean} Whether the text should trigger auto extraction.
   */
  function isWrittenPrompt(text) {
    // Require enough substance to avoid firing on short searches or labels.
    return String(text || "").trim().length >= MIN_AUTODETECT_PROMPT_LENGTH;
  }

  /**
   * Reads prompt text from an editable element.
   * @param {Element} element - Element that may contain prompt text.
   * @returns {string} Trimmed prompt text.
   */
  function getEditableText(element) {
    // Ignore non-editable nodes before reading values.
    if (!element || !element.matches("textarea, input[type='text'], input[type='search'], [contenteditable='true'], [role='textbox']")) {
      return "";
    }

    // Use form values for inputs and text content for rich editors.
    const rawText = element.matches("textarea, input") ? element.value || "" : element.textContent || "";
    return rawText.trim();
  }

  /**
   * Notifies the extension that a prompt has been authored on the page.
   * @param {Element} element - Editable element that contains the prompt.
   * @param {string} promptText - Detected prompt text.
   */
  function notifyPromptWritten(element, promptText) {
    // Avoid repeatedly triggering extraction for unchanged text.
    if (promptText === lastDetectedPromptText) {
      return;
    }
    lastDetectedPromptText = promptText;

    // Send enough context for the popup/background to validate the page source.
    const messagePromise = chrome.runtime.sendMessage({
      action: "PROMPT_WRITTEN_DETECTED",
      selection: {
        text: promptText,
        source: element.tagName.toLowerCase(),
        selector: getElementPath(element)
      }
    });

    // Ignore delivery failures caused by reloads or disabled extension contexts.
    if (messagePromise && typeof messagePromise.catch === "function") {
      messagePromise.catch(() => {});
    }
  }

  /**
   * Handles user edits in prompt-like fields.
   * @param {Event} event - Input event from the page.
   */
  function handlePromptInput(event) {
    // Debounce typing so extraction waits until the prompt settles briefly.
    window.clearTimeout(promptDetectionTimer);
    promptDetectionTimer = window.setTimeout(() => {
      const target = event.target;
      const promptText = getEditableText(target);

      // Trigger only once a candidate prompt has enough content.
      if (isWrittenPrompt(promptText)) {
        notifyPromptWritten(target, promptText);
      }
    }, AUTODETECT_DEBOUNCE_MS);
  }

  /**
   * Resolve the best prompt to lint.
   * @param {string | undefined} explicitText - Optional explicit text from popup.
   * @returns {{text: string, source: string, selector: string}} Resolved prompt source.
   */
  function resolvePrompt(explicitText) {
    // Respect explicit popup text first.
    if (typeof explicitText === "string" && explicitText.trim().length > 0) {
      return {
        text: explicitText.trim(),
        source: "popup-input",
        selector: "manual"
      };
    }

    // Prefer selected text when user highlights a prompt candidate on page.
    const selectedText = getSelectedText();
    if (selectedText.length > 0) {
      return {
        text: selectedText,
        source: "selected-text",
        selector: "selection"
      };
    }

    // Fall back to the currently focused editable field.
    const activeElement = document.activeElement;
    if (activeElement && activeElement.matches("textarea, input[type='text'], input[type='search'], [contenteditable='true'], [role='textbox']")) {
      const focusedText =
        activeElement.matches("textarea, input") ? activeElement.value || "" : activeElement.textContent || "";
      if (focusedText.trim().length > 0) {
        return {
          text: focusedText.trim(),
          source: "active-element",
          selector: getElementPath(activeElement)
        };
      }
    }

    // Otherwise pick the largest candidate on page.
    const candidates = collectPromptCandidates();
    if (candidates.length === 0) {
      return {
        text: "",
        source: "none",
        selector: ""
      };
    }
    const best = candidates.sort((a, b) => b.text.length - a.text.length)[0];
    return {
      text: best.text,
      source: best.source,
      selector: best.selector
    };
  }

  /**
   * Finds an editable element for prompt updates.
   * @param {string | undefined} selector - Previously captured element selector.
   * @returns {Element | null} Editable prompt element or null.
   */
  function findEditableTarget(selector) {
    // Prefer the captured selector so replacements apply to the original field.
    if (selector) {
      try {
        const selectedElement = document.querySelector(selector);
        if (selectedElement) {
          return selectedElement;
        }
      } catch (_error) {
        // Invalid selector paths fall through to active element handling.
      }
    }

    // Fall back to the active editor when the original selector is unavailable.
    const activeElement = document.activeElement;
    if (activeElement && activeElement.matches("textarea, input[type='text'], input[type='search'], [contenteditable='true'], [role='textbox']")) {
      return activeElement;
    }

    // Use the largest detected candidate as a final fallback.
    const prompt = resolvePrompt();
    try {
      return prompt.selector ? document.querySelector(prompt.selector) : null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Updates an editable element with revised prompt text.
   * @param {Element} element - Editable prompt element.
   * @param {string} promptText - Replacement prompt text.
   */
  function setEditableText(element, promptText) {
    // Apply value changes through native setters for framework-controlled fields.
    if (element.matches("textarea")) {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (valueSetter) {
        valueSetter.call(element, promptText);
      } else {
        element.value = promptText;
      }
    } else if (element.matches("input")) {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (valueSetter) {
        valueSetter.call(element, promptText);
      } else {
        element.value = promptText;
      }
    } else {
      element.textContent = promptText;
    }

    // Notify page scripts that the editable prompt changed.
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: promptText }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Applies a prompt replacement to the page.
   * @param {string} promptText - Replacement prompt text.
   * @param {string | undefined} selector - Previously captured element selector.
   * @returns {boolean} Whether the prompt was updated.
   */
  function applyPromptReplacement(promptText, selector) {
    // Resolve the field before mutating page content.
    const target = findEditableTarget(selector);
    if (!target) {
      return false;
    }

    // Write the replacement and keep duplicate auto-detection quiet.
    setEditableText(target, promptText);
    lastDetectedPromptText = String(promptText || "").trim();
    return true;
  }

  /**
   * Checks whether this content script is running on ChatGPT.
   * @returns {boolean} Whether the current page host is ChatGPT.
   */
  function isChatGptPage() {
    // Match the first-party ChatGPT domain and any official subdomains.
    const hostname = window.location.hostname.toLowerCase();
    return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com");
  }

  /**
   * Requests the background extract workflow during ChatGPT polling.
   * @returns {Promise<void>} Promise resolved after the poll attempt.
   */
  async function runChatGptExtractPoll() {
    // Avoid concurrent extraction if the previous poll is still running.
    if (chatGptPollInProgress) {
      return;
    }

    chatGptPollInProgress = true;
    try {
      // Ask the background worker to reuse the existing page extraction workflow.
      await chrome.runtime.sendMessage({
        action: "RUN_EXTRACT_PROMPT_FROM_PAGE_WORKFLOW"
      });
    } catch (_error) {
      // Polling can race with reloads or extension restarts, so failures are non-fatal.
    } finally {
      // Allow the next interval tick to run a fresh extraction attempt.
      chatGptPollInProgress = false;
    }
  }

  /**
   * Starts periodic prompt extraction for ChatGPT pages.
   */
  function startChatGptExtractPoller() {
    // Keep polling scoped to ChatGPT so other pages retain event-driven behavior.
    if (!isChatGptPage()) {
      return;
    }

    window.setInterval(runChatGptExtractPoll, CHATGPT_EXTRACT_POLL_INTERVAL_MS);
  }

  /**
   * Creates a compact text element for the overlay.
   * @param {string} tagName - HTML tag name to create.
   * @param {string} text - Text content to render.
   * @returns {HTMLElement} Rendered element.
   */
  function createOverlayTextElement(tagName, text) {
    // Use textContent so prompt content never becomes HTML.
    const element = document.createElement(tagName);
    element.textContent = text;
    return element;
  }

  /**
   * Collects overlay underline ranges from lint findings.
   * @param {Array<object>} findings - Lint findings from the extension.
   * @returns {Array<object>} Non-overlapping annotation groups.
   */
  function collectOverlayAnnotationGroups(findings) {
    // Combine highlights that target the same prompt range.
    const groupsByRange = new Map();
    findings.forEach((finding) => {
      (finding.highlights || []).forEach((highlight) => {
        const key = `${highlight.start}:${highlight.end}`;
        const group = groupsByRange.get(key) || {
          start: highlight.start,
          end: highlight.end,
          messages: [],
          options: []
        };
        group.messages.push(highlight.message);
        group.options = group.options.concat(highlight.options || []);
        groupsByRange.set(key, group);
      });
    });

    // Merge overlaps because HTML spans cannot overlap cleanly.
    const groups = Array.from(groupsByRange.values()).sort((a, b) => a.start - b.start || b.end - a.end);
    return groups.reduce((merged, group) => {
      const previous = merged[merged.length - 1];
      if (previous && group.start < previous.end) {
        previous.end = Math.max(previous.end, group.end);
        previous.messages = previous.messages.concat(group.messages);
        previous.options = previous.options.concat(group.options);
        return merged;
      }
      merged.push(group);
      return merged;
    }, []);
  }

  /**
   * Creates a hover tooltip for overlay annotations.
   * @param {Array<string>} messages - Lint messages for this underline.
   * @param {Array<object>} options - Resolution options for this underline.
   * @param {string | undefined} selector - Prompt source selector.
   * @returns {HTMLSpanElement} Tooltip element.
   */
  function createOverlayTooltip(messages, options, selector) {
    // Render clickable options that replace the source prompt field.
    const tooltip = document.createElement("span");
    tooltip.style.display = "none";
    tooltip.style.position = "absolute";
    tooltip.style.left = "0";
    tooltip.style.bottom = "100%";
    tooltip.style.width = "240px";
    tooltip.style.maxHeight = "220px";
    tooltip.style.overflowY = "auto";
    tooltip.style.padding = "6px";
    tooltip.style.borderRadius = "8px";
    tooltip.style.background = "#020617";
    tooltip.style.color = "#f8fafc";
    tooltip.style.fontSize = "11px";
    tooltip.style.lineHeight = "1.25";
    tooltip.style.boxShadow = "0 10px 24px rgba(0,0,0,0.35)";
    tooltip.style.zIndex = "2147483647";
    tooltip.addEventListener("wheel", (event) => {
      // Keep tooltip scrolling from moving the underlying page or editor.
      event.stopPropagation();
    });

    const title = createOverlayTextElement("strong", messages.filter(Boolean).join(" "));
    title.style.display = "block";
    title.style.marginBottom = "4px";
    title.style.fontSize = "11px";
    title.style.lineHeight = "1.25";
    tooltip.appendChild(title);
    const seen = new Set();
    options.forEach((option) => {
      const key = `${option.label}::${option.description}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${option.label}: ${option.description}`;
      button.style.display = "block";
      button.style.width = "100%";
      button.style.marginTop = "4px";
      button.style.border = "0";
      button.style.borderRadius = "6px";
      button.style.background = "#2563eb";
      button.style.color = "#eff6ff";
      button.style.padding = "4px 6px";
      button.style.textAlign = "left";
      button.style.cursor = "pointer";
      button.style.fontSize = "11px";
      button.style.fontWeight = "600";
      button.style.lineHeight = "1.25";
      button.style.whiteSpace = "normal";
      button.addEventListener("click", (event) => {
        // Prevent the overlay click from bubbling into page controls.
        event.preventDefault();
        event.stopPropagation();
        if (option.replacement && applyPromptReplacement(option.replacement, selector)) {
          const fieldOverlay = document.getElementById("prompt-linter-field-overlay");
          if (fieldOverlay) {
            fieldOverlay.remove();
          }
          button.textContent = "Suggestion applied";
        }
      });
      tooltip.appendChild(button);
    });

    return tooltip;
  }

  /**
   * Keeps an overlay tooltip open during forgiving pointer movement.
   * @param {HTMLElement} underline - Underlined text span.
   * @param {HTMLElement} tooltip - Tooltip shown for the underline.
   */
  function wireStableOverlayTooltip(underline, tooltip) {
    // Delay closing so moving into the tooltip does not dismiss it.
    let closeTimer = null;

    /**
     * Opens the tooltip and cancels any pending close.
     */
    function openTooltip() {
      // Use inline display because the content script owns these styles.
      window.clearTimeout(closeTimer);
      tooltip.style.display = "block";
    }

    /**
     * Closes the tooltip after a small grace period.
     */
    function scheduleCloseTooltip() {
      // A small delay tolerates diagonal movement and internal scrolling.
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => {
        tooltip.style.display = "none";
      }, 350);
    }

    // Keep the tooltip open while either element is hovered.
    underline.addEventListener("mouseenter", openTooltip);
    underline.addEventListener("mouseleave", scheduleCloseTooltip);
    tooltip.addEventListener("mouseenter", openTooltip);
    tooltip.addEventListener("mouseleave", scheduleCloseTooltip);

    // Keep keyboard focus transitions into tooltip buttons from closing it.
    underline.addEventListener("focusin", openTooltip);
    underline.addEventListener("focusout", (event) => {
      if (!tooltip.contains(event.relatedTarget)) {
        scheduleCloseTooltip();
      }
    });
    tooltip.addEventListener("focusin", openTooltip);
    tooltip.addEventListener("focusout", (event) => {
      if (!underline.contains(event.relatedTarget)) {
        scheduleCloseTooltip();
      }
    });
  }

  /**
   * Renders the prompt with red underlines in the page overlay.
   * @param {string} promptText - Prompt text to annotate.
   * @param {Array<object>} findings - Lint findings with highlight ranges.
   * @param {string | undefined} selector - Prompt source selector.
   * @returns {HTMLDivElement} Annotated prompt container.
   */
  function renderOverlayAnnotatedPrompt(promptText, findings, selector) {
    // Build a read-only annotated view rather than mutating the page prompt.
    const promptContainer = document.createElement("div");
    const groups = collectOverlayAnnotationGroups(findings);
    let cursor = 0;
    promptContainer.style.whiteSpace = "pre-wrap";
    promptContainer.style.lineHeight = "1.45";
    promptContainer.style.border = "1px solid #334155";
    promptContainer.style.borderRadius = "8px";
    promptContainer.style.padding = "8px";
    promptContainer.style.background = "#0b1224";

    groups.forEach((group) => {
      if (group.start > cursor) {
        promptContainer.appendChild(document.createTextNode(promptText.slice(cursor, group.start)));
      }

      const underline = document.createElement("span");
      const tooltip = createOverlayTooltip(group.messages, group.options, selector);
      underline.textContent = promptText.slice(group.start, group.end);
      underline.style.position = "relative";
      underline.style.textDecorationLine = "underline";
      underline.style.textDecorationColor = "#ef4444";
      underline.style.textDecorationStyle = "wavy";
      underline.style.textDecorationThickness = "2px";
      underline.style.cursor = "help";
      underline.tabIndex = 0;
      underline.appendChild(tooltip);
      wireStableOverlayTooltip(underline, tooltip);
      promptContainer.appendChild(underline);
      cursor = group.end;
    });

    if (cursor < promptText.length) {
      promptContainer.appendChild(document.createTextNode(promptText.slice(cursor)));
    }
    return promptContainer;
  }

  /**
   * Reads prompt text from the original editable field.
   * @param {Element} element - Editable element to inspect.
   * @returns {string} Prompt text from the field.
   */
  function getFieldPromptText(element) {
    // Match the extraction behavior for form and rich-text fields.
    if (element.matches("textarea, input")) {
      return element.value || "";
    }
    return element.textContent || "";
  }

  /**
   * Copies relevant text layout styles from the page field.
   * @param {HTMLElement} layer - Annotation layer to style.
   * @param {Element} target - Source editable element.
   */
  function copyFieldTextStyles(layer, target) {
    // Align overlay text with the field as closely as the page allows.
    const styles = window.getComputedStyle(target);
    layer.style.fontFamily = styles.fontFamily;
    layer.style.fontSize = styles.fontSize;
    layer.style.fontWeight = styles.fontWeight;
    layer.style.lineHeight = styles.lineHeight;
    layer.style.letterSpacing = styles.letterSpacing;
    layer.style.padding = styles.padding;
    layer.style.whiteSpace = target.matches("input") ? "pre" : "pre-wrap";
  }

  /**
   * Positions a field annotation layer over its source field.
   * @param {HTMLElement} layer - Annotation layer to position.
   * @param {Element} target - Source editable element.
   */
  function positionFieldAnnotationLayer(layer, target) {
    // Use fixed positioning so the layer follows viewport coordinates.
    const rect = target.getBoundingClientRect();
    layer.style.left = `${rect.left}px`;
    layer.style.top = `${rect.top}px`;
    layer.style.width = `${rect.width}px`;
    layer.style.height = `${rect.height}px`;
    layer.scrollTop = target.scrollTop || 0;
    layer.scrollLeft = target.scrollLeft || 0;
  }

  /**
   * Renders red underlines over the actual source prompt field.
   * @param {string} promptText - Prompt text to annotate.
   * @param {Array<object>} findings - Lint findings with highlight ranges.
   * @param {string | undefined} selector - Prompt source selector.
   */
  function renderFieldAnnotationLayer(promptText, findings, selector) {
    // Remove stale field overlays before drawing the latest lint state.
    const existing = document.getElementById("prompt-linter-field-overlay");
    if (existing) {
      existing.remove();
    }

    // Only annotate editable fields that can be located on the page.
    const target = findEditableTarget(selector);
    if (!target) {
      return;
    }

    // Build a transparent text mirror with clickable underline spans.
    const layer = document.createElement("div");
    const groups = collectOverlayAnnotationGroups(findings);
    let cursor = 0;
    layer.id = "prompt-linter-field-overlay";
    layer.style.position = "fixed";
    layer.style.zIndex = "2147483646";
    layer.style.overflow = "visible";
    layer.style.color = "transparent";
    layer.style.pointerEvents = "none";
    layer.style.boxSizing = "border-box";
    copyFieldTextStyles(layer, target);
    positionFieldAnnotationLayer(layer, target);

    groups.forEach((group) => {
      if (group.start > cursor) {
        layer.appendChild(document.createTextNode(promptText.slice(cursor, group.start)));
      }

      const underline = document.createElement("span");
      const tooltip = createOverlayTooltip(group.messages, group.options, selector);
      underline.textContent = promptText.slice(group.start, group.end);
      underline.style.position = "relative";
      underline.style.textDecorationLine = "underline";
      underline.style.textDecorationColor = "#ef4444";
      underline.style.textDecorationStyle = "wavy";
      underline.style.textDecorationThickness = "2px";
      underline.style.cursor = "help";
      underline.style.pointerEvents = "auto";
      underline.tabIndex = 0;
      underline.appendChild(tooltip);
      wireStableOverlayTooltip(underline, tooltip);
      layer.appendChild(underline);
      cursor = group.end;
    });

    if (cursor < promptText.length) {
      layer.appendChild(document.createTextNode(promptText.slice(cursor)));
    }

    // Keep the underline layer aligned as the user scrolls or the page moves.
    target.addEventListener("scroll", () => positionFieldAnnotationLayer(layer, target), { passive: true });
    window.addEventListener("scroll", () => positionFieldAnnotationLayer(layer, target), { passive: true });
    window.addEventListener("resize", () => positionFieldAnnotationLayer(layer, target), { passive: true });
    document.body.appendChild(layer);
  }

  /**
   * Create a short on-page analysis overlay.
   * @param {object} payload - Analysis payload from popup.
   */
  function renderOverlay(payload) {
    // Remove any prior overlay.
    const existing = document.getElementById("prompt-linter-overlay");
    if (existing) {
      existing.remove();
    }
    const existingFieldOverlay = document.getElementById("prompt-linter-field-overlay");
    if (existingFieldOverlay) {
      existingFieldOverlay.remove();
    }

    // Build simple fixed panel for immediate feedback.
    const container = document.createElement("div");
    container.id = "prompt-linter-overlay";
    container.style.position = "fixed";
    container.style.bottom = "16px";
    container.style.right = "16px";
    container.style.width = "320px";
    container.style.maxHeight = "50vh";
    container.style.overflow = "auto";
    container.style.padding = "12px";
    container.style.borderRadius = "10px";
    container.style.background = "#101218";
    container.style.color = "#f4f6ff";
    container.style.fontFamily = "system-ui, sans-serif";
    container.style.fontSize = "12px";
    container.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";
    container.style.zIndex = "2147483647";

    // Include headline metrics and the prompt problems only.
    const findings = Array.isArray(payload?.analysis?.findings) ? payload.analysis.findings.slice(0, 4) : [];
    const promptText = String(payload?.promptText || payload?.selection?.text || "");
    const selector = payload?.selection?.selector;
    const target = findEditableTarget(selector);
    const fieldPromptText = target ? getFieldPromptText(target) : promptText;
    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "8px";

    const title = createOverlayTextElement("strong", "Prompt Linter");
    const closeButton = document.createElement("button");
    closeButton.id = "prompt-linter-close";
    closeButton.textContent = "x";
    closeButton.style.background = "#22283a";
    closeButton.style.color = "#fff";
    closeButton.style.border = "0";
    closeButton.style.borderRadius = "6px";
    closeButton.style.padding = "2px 8px";
    closeButton.style.cursor = "pointer";
    closeButton.addEventListener("click", () => container.remove());
    header.appendChild(title);
    header.appendChild(closeButton);

    const score = createOverlayTextElement("div", `Score: ${payload?.analysis?.score ?? "-"} / 100`);
    score.style.marginBottom = "6px";
    const severity = createOverlayTextElement("div", `Severity: ${payload?.analysis?.severity ?? "-"}`);
    severity.style.marginBottom = "8px";
    const findingsTitle = createOverlayTextElement("div", "Prompt problems");
    findingsTitle.style.fontWeight = "600";
    findingsTitle.style.marginBottom = "6px";

    const findingsList = document.createElement("ul");
    findingsList.style.margin = "0";
    findingsList.style.padding = "0 0 0 16px";
    findingsList.style.display = "flex";
    findingsList.style.flexDirection = "column";
    findingsList.style.gap = "6px";

    if (findings.length === 0) {
      const emptyItem = createOverlayTextElement("li", "No problems detected.");
      findingsList.appendChild(emptyItem);
    } else {
      findings.forEach((finding) => {
        // Keep the overlay focused on issues instead of interactive fixes.
        const severityLabel = finding.severity ? `${String(finding.severity).toUpperCase()}: ` : "";
        const item = createOverlayTextElement("li", `${severityLabel}${finding.message || "Prompt issue detected."}`);
        findingsList.appendChild(item);
      });
    }
    renderFieldAnnotationLayer(fieldPromptText, findings, selector);

    container.appendChild(header);
    container.appendChild(score);
    container.appendChild(severity);
    container.appendChild(findingsTitle);
    container.appendChild(findingsList);

    // Insert into document.
    document.body.appendChild(container);
  }

  /**
   * Handle extension messages for prompt extraction and overlay rendering.
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Route by action type.
    if (message?.action === "COLLECT_PROMPT") {
      const selection = resolvePrompt(message.promptText);
      sendResponse({
        ok: true,
        selection
      });
      return true;
    }

    if (message?.action === "RENDER_ANALYSIS_OVERLAY") {
      renderOverlay(message.payload);
      sendResponse({ ok: true });
      return true;
    }

    if (message?.action === "APPLY_PROMPT_TEXT") {
      const wasApplied = applyPromptReplacement(message.payload?.text || "", message.payload?.selector);
      sendResponse({ ok: wasApplied });
      return true;
    }

    // Return false for unhandled actions.
    return false;
  });

  // Listen in capture phase so dynamically rendered editors are detected.
  document.addEventListener("input", handlePromptInput, true);
  startChatGptExtractPoller();
})();
