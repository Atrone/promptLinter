/**
 * Gets the active tab in the current window.
 * @returns {Promise<chrome.tabs.Tab | null>} Active tab or null.
 */
async function getActiveTab() {
  // Query browser for currently active tab.
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

/**
 * Requests prompt collection from content script.
 * @param {number} tabId - Active tab identifier.
 * @param {string} promptText - Optional prompt text provided by popup.
 * @returns {Promise<object>} Prompt selection result.
 */
async function collectPromptFromTab(tabId, promptText) {
  // Forward collection request to content script in target tab.
  const response = await chrome.tabs.sendMessage(tabId, {
    action: "COLLECT_PROMPT",
    promptText: promptText
  });
  return response;
}

/**
 * Sends analysis payload for overlay rendering on page.
 * @param {number} tabId - Active tab identifier.
 * @param {object} payload - Analysis details.
 * @returns {Promise<object>} Overlay response.
 */
async function renderOverlayOnTab(tabId, payload) {
  // Ask content script to display compact overlay panel.
  const response = await chrome.tabs.sendMessage(tabId, {
    action: "RENDER_ANALYSIS_OVERLAY",
    payload: payload
  });
  return response;
}

/**
 * Registers install-time setup logging.
 */
chrome.runtime.onInstalled.addListener(() => {
  // Keep an install log for troubleshooting.
  console.info("Prompt Linter extension installed.");
});

/**
 * Handles runtime messages from popup script.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Process asynchronously to support tab messaging.
  (async () => {
    try {
      if (message && message.action === "GET_PROMPT_FROM_ACTIVE_TAB") {
        // Resolve currently active tab for prompt collection.
        const tab = await getActiveTab();
        if (!tab || typeof tab.id !== "number") {
          sendResponse({ ok: false, error: "No active tab available." });
          return;
        }

        const selection = await collectPromptFromTab(tab.id, message.promptText || "");
        if (!selection || !selection.ok) {
          sendResponse({ ok: false, error: "Unable to read prompt content from page." });
          return;
        }

        sendResponse({ ok: true, selection: selection.selection });
        return;
      }

      if (message && message.action === "SHOW_ANALYSIS_OVERLAY") {
        // Resolve active tab and request overlay rendering.
        const tab = await getActiveTab();
        if (!tab || typeof tab.id !== "number") {
          sendResponse({ ok: false, error: "No active tab available." });
          return;
        }

        await renderOverlayOnTab(tab.id, message.payload || {});
        sendResponse({ ok: true });
        return;
      }

      // Reject unknown action identifiers.
      sendResponse({ ok: false, error: "Unsupported action." });
    } catch (error) {
      // Return error details to popup for user-facing feedback.
      sendResponse({ ok: false, error: error.message || "Unexpected extension error." });
    }
  })();

  return true;
});
