import { lintPrompt } from "./linter.js";

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
 * Saves the latest auto-detected prompt for the popup.
 * @param {number} tabId - Tab where the prompt was detected.
 * @param {object} selection - Prompt selection metadata.
 * @returns {Promise<void>} Promise resolved after storage update.
 */
async function saveDetectedPrompt(tabId, selection) {
  // Keep only the latest prompt detection so popup startup remains simple.
  await chrome.storage.local.set({
    promptLinterAutoExtract: {
      tabId: tabId,
      detectedAt: Date.now(),
      selection: selection || null
    }
  });
}

/**
 * Notifies any open popup that the active page has a prompt ready to extract.
 * @param {number} tabId - Tab where the prompt was detected.
 * @returns {Promise<void>} Promise resolved after notification attempt.
 */
async function notifyPopupPromptDetected(tabId) {
  // Runtime messaging fails when the popup is closed, which is expected.
  try {
    await chrome.runtime.sendMessage({
      action: "RUN_EXTRACT_FROM_PAGE",
      tabId: tabId
    });
  } catch (_error) {
    // Closed popups cannot receive messages; stored state covers next open.
  }
}

/**
 * Marks the extension action to show that a prompt was detected on the page.
 * @param {number} tabId - Tab where the prompt was detected.
 * @returns {Promise<void>} Promise resolved after badge update.
 */
async function markPromptDetected(tabId) {
  // Give the user a subtle cue when the popup is not currently open.
  await chrome.action.setBadgeText({ tabId: tabId, text: "!" });
  await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: "#3b82f6" });
}

/**
 * Computes an overall severity label from issue collection.
 * @param {Array<{severity:string}>} issues - Linter issue list.
 * @returns {"high"|"medium"|"low"|"none"} Highest severity present.
 */
function getOverallSeverity(issues) {
  // Promote the most severe issue for badge and overlay display.
  if (issues.some(function hasHigh(item) { return item.severity === "high"; })) {
    return "high";
  }
  if (issues.some(function hasMedium(item) { return item.severity === "medium"; })) {
    return "medium";
  }
  if (issues.length > 0) {
    return "low";
  }
  return "none";
}

/**
 * Runs the existing extract, lint, and overlay workflow for a detected prompt.
 * @param {number} tabId - Tab where the prompt was detected.
 * @param {string} promptText - Prompt text detected from the page.
 * @returns {Promise<void>} Promise resolved after workflow attempt.
 */
async function runAutomaticExtractWorkflow(tabId, promptText) {
  // Reuse content extraction so detection follows the same source rules as the button.
  const collectedPrompt = await collectPromptFromTab(tabId, promptText || "");
  if (!collectedPrompt || !collectedPrompt.ok || !collectedPrompt.selection || !collectedPrompt.selection.text) {
    return;
  }

  // Lint the extracted prompt and shape the payload expected by the overlay.
  const lintResult = lintPrompt(collectedPrompt.selection.text);
  await renderOverlayOnTab(tabId, {
    analysis: {
      score: lintResult.score,
      severity: getOverallSeverity(lintResult.issues),
      findings: lintResult.issues.map(function mapIssue(issue) {
        // Keep overlay findings compact while preserving apply actions.
        return {
          message: issue.message,
          severity: issue.severity,
          action: issue.action
        };
      })
    },
    selection: collectedPrompt.selection
  });
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

      if (message && message.action === "PROMPT_WRITTEN_DETECTED") {
        // Store and broadcast prompt detection from content scripts.
        const tabId = _sender && _sender.tab ? _sender.tab.id : null;
        if (typeof tabId !== "number") {
          sendResponse({ ok: false, error: "No source tab available." });
          return;
        }

        await saveDetectedPrompt(tabId, message.selection || null);
        await markPromptDetected(tabId);
        await notifyPopupPromptDetected(tabId);
        try {
          // Run extraction immediately even when the popup is closed.
          await runAutomaticExtractWorkflow(tabId, message.selection ? message.selection.text : "");
        } catch (_error) {
          // Popup/manual extraction remains available if automatic overlay fails.
        }
        sendResponse({ ok: true });
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
