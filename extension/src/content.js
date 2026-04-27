/**
 * Prompt linter content script utilities.
 * This file handles prompt extraction and analysis rendering on the active page.
 */
(function promptLinterContentScript() {
  const MIN_AUTODETECT_PROMPT_LENGTH = 20;
  const AUTODETECT_DEBOUNCE_MS = 700;
  let promptDetectionTimer = null;
  let lastDetectedPromptText = "";

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
    // Prefer the captured selector so fixes apply to the original field.
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
   * Creates an apply button for an overlay lint finding.
   * @param {object} finding - Lint finding with an action payload.
   * @param {string | undefined} selector - Prompt source selector.
   * @returns {HTMLButtonElement} Rendered apply button.
   */
  function createOverlayApplyButton(finding, selector) {
    // Render one-click fix controls like an inline writing assistant.
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = finding?.action?.label || "Apply fix";
    button.style.marginTop = "6px";
    button.style.border = "0";
    button.style.borderRadius = "6px";
    button.style.background = "#2563eb";
    button.style.color = "#eff6ff";
    button.style.padding = "5px 8px";
    button.style.cursor = "pointer";
    button.style.fontWeight = "700";

    // Apply the replacement to the original editable prompt field.
    button.addEventListener("click", () => {
      const replacement = finding?.action?.replacement || "";
      if (replacement && applyPromptReplacement(replacement, selector)) {
        button.textContent = "Applied";
      }
    });

    return button;
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

    // Include headline metrics and top findings.
    const findings = Array.isArray(payload?.analysis?.findings) ? payload.analysis.findings.slice(0, 4) : [];
    const selector = payload?.selection?.selector;
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
    const findingsTitle = createOverlayTextElement("div", "Fix suggestions");
    findingsTitle.style.fontWeight = "600";
    findingsTitle.style.marginBottom = "4px";
    const findingsList = document.createElement("ul");
    findingsList.style.margin = "0";
    findingsList.style.paddingLeft = "18px";

    findings.forEach((finding) => {
      const item = document.createElement("li");
      const message = createOverlayTextElement("div", finding.message);
      item.appendChild(message);
      if (finding.action && finding.action.replacement) {
        item.appendChild(createOverlayApplyButton(finding, selector));
      }
      findingsList.appendChild(item);
    });

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
})();
