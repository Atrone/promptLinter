/**
 * Prompt linter content script utilities.
 * This file handles prompt extraction and analysis rendering on the active page.
 */
(function promptLinterContentScript() {
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
    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong>Prompt Linter</strong>
        <button id="prompt-linter-close" style="background:#22283a;color:#fff;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;">x</button>
      </div>
      <div style="margin-bottom:6px;">Score: <strong>${payload?.analysis?.score ?? "-"}</strong> / 100</div>
      <div style="margin-bottom:8px;">Severity: <strong>${payload?.analysis?.severity ?? "-"}</strong></div>
      <div style="font-weight:600;margin-bottom:4px;">Top findings</div>
      <ul style="margin:0;padding-left:18px;">
        ${findings.map((finding) => `<li>${finding.message}</li>`).join("")}
      </ul>
    `;

    // Wire close action.
    const closeButton = container.querySelector("#prompt-linter-close");
    if (closeButton) {
      closeButton.addEventListener("click", () => container.remove());
    }

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

    // Return false for unhandled actions.
    return false;
  });
})();
