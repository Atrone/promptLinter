import { lintPrompt, buildImprovedPrompt } from "./linter.js";

var AUTO_EXTRACT_MAX_AGE_MS = 5 * 60 * 1000;
var autoExtractInProgress = false;
var currentPromptSelection = null;

/**
 * Maps score numbers into user-facing quality tones.
 * @param {number} score - Prompt score from 0 to 100.
 * @returns {string} Score tone text.
 */
function getScoreTone(score) {
  // Use coarse score buckets to keep the summary easy to scan.
  if (score >= 85) {
    return "Strong prompt quality.";
  }
  if (score >= 65) {
    return "Good baseline with room to improve.";
  }
  if (score >= 40) {
    return "Needs structure and stronger constraints.";
  }
  return "High risk of vague or inconsistent outputs.";
}

/**
 * Sorts lint issues by severity and rule identifier.
 * @param {Array<{severity:string,rule:string}>} issues - Raw issues from linter.
 * @returns {Array<object>} Sorted issue list.
 */
function sortIssues(issues) {
  // Prioritize issues by severity so important fixes appear first.
  var severityOrder = { high: 0, medium: 1, low: 2 };
  return issues.slice().sort(function bySeverity(a, b) {
    var rankA = severityOrder[a.severity] ?? 3;
    var rankB = severityOrder[b.severity] ?? 3;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return String(a.rule).localeCompare(String(b.rule));
  });
}

/**
 * Clears all children from a list element.
 * @param {HTMLElement} listElement - Target list element.
 */
function clearList(listElement) {
  // Reset list contents safely without injecting HTML.
  listElement.textContent = "";
}

/**
 * Creates a list card item.
 * @param {string} title - Card heading text.
 * @param {string} body - Card body text.
 * @returns {HTMLLIElement} Rendered list element.
 */
function createListItem(title, body) {
  // Create semantic nodes to avoid HTML string interpolation.
  var item = document.createElement("li");
  item.className = "card";

  var heading = document.createElement("h3");
  heading.textContent = title;

  var paragraph = document.createElement("p");
  paragraph.textContent = body;

  item.appendChild(heading);
  item.appendChild(paragraph);
  return item;
}

/**
 * Creates a card item with an applyable lint fix.
 * @param {object} issue - Lint issue with action metadata.
 * @param {number} index - Display index for the issue.
 * @returns {HTMLLIElement} Rendered issue action element.
 */
function createIssueActionItem(issue, index) {
  // Build the card using DOM nodes so action text remains safe.
  var item = document.createElement("li");
  item.className = "card";

  var heading = document.createElement("h3");
  heading.textContent = (index + 1) + ". " + issue.rule + " (" + String(issue.severity).toUpperCase() + ")";

  var paragraph = document.createElement("p");
  paragraph.textContent = issue.message + " Fix: " + issue.fix;

  var actionDescription = document.createElement("p");
  actionDescription.className = "card__action-description";
  actionDescription.textContent = issue.action && issue.action.description ? issue.action.description : "Apply a suggested rewrite.";

  var button = document.createElement("button");
  button.type = "button";
  button.className = "card__action";
  button.textContent = issue.action && issue.action.label ? issue.action.label : "Apply fix";
  button.addEventListener("click", function handleApplyClick() {
    // Apply the issue rewrite to the prompt and refresh lint output.
    applyIssueAction(issue);
  });

  item.appendChild(heading);
  item.appendChild(paragraph);
  item.appendChild(actionDescription);
  item.appendChild(button);
  return item;
}

/**
 * Computes an overall severity label from issue collection.
 * @param {Array<{severity:string}>} issues - Linter issue list.
 * @returns {"high"|"medium"|"low"|"none"} Highest severity present.
 */
function getOverallSeverity(issues) {
  // Promote the most severe issue for badge coloring.
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
 * Sends a message to the active tab's content script.
 * @param {object} message - Message payload.
 * @returns {Promise<any>} Response payload.
 */
async function sendMessageToActiveTab(message) {
  // Resolve active tab before forwarding the message.
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var activeTab = tabs[0];
  if (!activeTab || typeof activeTab.id !== "number") {
    throw new Error("No active tab found.");
  }
  return chrome.tabs.sendMessage(activeTab.id, message);
}

/**
 * Resolves the active tab identifier for popup-scoped actions.
 * @returns {Promise<number | null>} Active tab identifier or null.
 */
async function getActiveTabId() {
  // Match the tab lookup used by active-page extraction.
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var activeTab = tabs[0];
  return activeTab && typeof activeTab.id === "number" ? activeTab.id : null;
}

/**
 * Reads the latest prompt auto-detection record from extension storage.
 * @returns {Promise<object | null>} Stored auto-extract record or null.
 */
async function getPendingAutoExtract() {
  // Storage is populated by the background script when content detects typing.
  var result = await chrome.storage.local.get("promptLinterAutoExtract");
  return result && result.promptLinterAutoExtract ? result.promptLinterAutoExtract : null;
}

/**
 * Clears prompt auto-detection state for a tab.
 * @param {number} tabId - Tab identifier to clear.
 * @returns {Promise<void>} Promise resolved after state is cleared.
 */
async function clearAutoExtractState(tabId) {
  // Remove pending storage so stale detections do not rerun later.
  await chrome.storage.local.remove("promptLinterAutoExtract");

  // Clear the badge cue for the page after extraction is handled.
  if (typeof tabId === "number") {
    await chrome.action.setBadgeText({ tabId: tabId, text: "" });
  }
}

/**
 * Checks whether an auto-detection record applies to the current active tab.
 * @param {object | null} record - Stored auto-detection record.
 * @param {number | null} tabId - Current active tab identifier.
 * @returns {boolean} Whether auto extraction should run.
 */
function shouldRunAutoExtract(record, tabId) {
  // Only run for fresh detections on the tab the popup is inspecting.
  if (!record || typeof tabId !== "number" || record.tabId !== tabId) {
    return false;
  }

  // Ignore old detections that may no longer match the page content.
  return Date.now() - Number(record.detectedAt || 0) <= AUTO_EXTRACT_MAX_AGE_MS;
}

/**
 * Updates popup status line.
 * @param {string} text - Status message to render.
 */
function setStatus(text) {
  // Display operation progress near the popup title.
  document.getElementById("statusText").textContent = text;
}

/**
 * Renders lint output into popup summary and lists.
 * @param {object} lintResult - Result payload returned by lintPrompt.
 * @param {string} sourceLabel - Label describing prompt source.
 */
function renderResults(lintResult, sourceLabel) {
  // Resolve all result DOM nodes once per render.
  var scoreValue = document.getElementById("scoreValue");
  var scoreTone = document.getElementById("scoreTone");
  var sourceBadge = document.getElementById("sourceBadge");
  var summaryText = document.getElementById("summaryText");
  var issuesList = document.getElementById("issuesList");
  var suggestionsList = document.getElementById("suggestionsList");

  var sortedIssues = sortIssues(lintResult.issues);
  var overallSeverity = getOverallSeverity(sortedIssues);

  // Render top-line metrics and source information.
  scoreValue.textContent = String(lintResult.score);
  scoreTone.textContent = getScoreTone(lintResult.score);
  sourceBadge.textContent = sourceLabel;
  sourceBadge.setAttribute("data-severity", overallSeverity);
  summaryText.textContent = lintResult.summary;

  // Render issue cards ordered by severity.
  clearList(issuesList);
  if (sortedIssues.length === 0) {
    issuesList.appendChild(createListItem("No issues detected", "Prompt structure looks strong."));
  } else {
    sortedIssues.forEach(function renderIssue(issue, index) {
      issuesList.appendChild(createIssueActionItem(issue, index));
    });
  }

  // Render unique improvement suggestions from linter output.
  clearList(suggestionsList);
  if (!lintResult.suggestions || lintResult.suggestions.length === 0) {
    suggestionsList.appendChild(
      createListItem("Keep this structure", "Continue providing role, context, constraints, and output format.")
    );
  } else {
    lintResult.suggestions.forEach(function renderSuggestion(text, index) {
      suggestionsList.appendChild(createListItem((index + 1) + ". Suggestion", text));
    });
  }
}

/**
 * Runs linting for the current prompt textarea value.
 * @returns {object} Lint result payload.
 */
function lintCurrentPrompt() {
  // Gather prompt text and run lint rules.
  var promptText = document.getElementById("promptInput").value;
  var lintResult = lintPrompt(promptText);
  currentPromptSelection = null;
  renderResults(lintResult, "manual");
  setStatus("Lint complete.");
  return lintResult;
}

/**
 * Applies replacement prompt text to the active page when possible.
 * @param {string} promptText - Replacement prompt text.
 * @returns {Promise<void>} Promise resolved after page update attempt.
 */
async function applyPromptToActivePage(promptText) {
  // Skip page updates for prompts typed directly in the popup.
  if (!currentPromptSelection || !currentPromptSelection.selector) {
    return;
  }

  // Ask the content script to update the original prompt field.
  await sendMessageToActiveTab({
    action: "APPLY_PROMPT_TEXT",
    payload: {
      text: promptText,
      selector: currentPromptSelection.selector
    }
  });
}

/**
 * Applies a selected issue action to the current prompt.
 * @param {object} issue - Lint issue with action metadata.
 */
function applyIssueAction(issue) {
  // Ignore malformed issue actions defensively.
  if (!issue || !issue.action || !issue.action.replacement) {
    return;
  }

  // Update the popup prompt first so feedback is immediate.
  var promptInput = document.getElementById("promptInput");
  promptInput.value = issue.action.replacement;
  var lintResult = lintPrompt(promptInput.value);
  renderResults(lintResult, currentPromptSelection ? currentPromptSelection.source : "manual");
  setStatus("Fix applied.");

  // Mirror the fix back to the source page when the prompt was extracted.
  applyPromptToActivePage(promptInput.value).catch(function handleApplyError(error) {
    setStatus("Fix applied in popup. Page update failed: " + error.message);
  });
}

/**
 * Extracts a prompt candidate from the active page.
 * @returns {Promise<void>} Promise resolved when extraction completes.
 */
async function extractFromPage() {
  // Request a candidate prompt from the content script.
  setStatus("Extracting prompt from active page...");
  var response = await sendMessageToActiveTab({ action: "COLLECT_PROMPT" });
  if (!response || !response.ok) {
    throw new Error("Could not extract prompt from page.");
  }

  // Populate textarea and lint extracted text.
  var extractedPrompt = response.selection && response.selection.text ? response.selection.text : "";
  currentPromptSelection = response.selection || null;
  document.getElementById("promptInput").value = extractedPrompt;
  var lintResult = lintPrompt(extractedPrompt);
  renderResults(lintResult, (response.selection && response.selection.source) || "page");
  setStatus("Prompt extracted from page.");

  // Attempt to show an in-page overlay with top findings.
  try {
    await sendMessageToActiveTab({
      action: "RENDER_ANALYSIS_OVERLAY",
      payload: {
        analysis: {
          score: lintResult.score,
          severity: getOverallSeverity(lintResult.issues),
          findings: lintResult.issues.map(function mapIssue(issue) {
            // Map issue fields to the overlay shape.
            return {
              message: issue.message,
              severity: issue.severity,
              action: issue.action
            };
          })
        },
        selection: response.selection || null
      }
    });
  } catch (_error) {
    // Overlay failures should not block popup workflow.
  }
}

/**
 * Copies an improved prompt template to clipboard.
 * @returns {Promise<void>} Promise resolved after copy attempt.
 */
async function copyImprovedPrompt() {
  // Build improved prompt scaffolding based on current text.
  var promptText = document.getElementById("promptInput").value;
  var improvedPrompt = buildImprovedPrompt(promptText);
  await navigator.clipboard.writeText(improvedPrompt);
  setStatus("Improved prompt copied.");
}

/**
 * Clears prompt input and rendered result sections.
 * @param {boolean} updateStatus - Whether to update status text.
 */
function clearAll(updateStatus) {
  // Reset prompt field and summary widgets to defaults.
  currentPromptSelection = null;
  document.getElementById("promptInput").value = "";
  document.getElementById("scoreValue").textContent = "--";
  document.getElementById("scoreTone").textContent = "Run lint to score this prompt.";
  document.getElementById("sourceBadge").textContent = "none";
  document.getElementById("sourceBadge").setAttribute("data-severity", "none");
  document.getElementById("summaryText").textContent = "Run linting to see feedback.";
  clearList(document.getElementById("issuesList"));
  clearList(document.getElementById("suggestionsList"));
  if (updateStatus) {
    // Keep user informed when clear action is explicit.
    setStatus("Cleared.");
  }
}

/**
 * Handles the extract button click action.
 * @returns {Promise<void>} Promise resolved when extraction finishes.
 */
async function handleExtractClick() {
  // Catch extraction failures and surface a readable status.
  try {
    await extractFromPage();
  } catch (error) {
    setStatus("Extract failed: " + error.message);
  }
}

/**
 * Runs the extract workflow in response to page-side prompt detection.
 * @param {number} detectedTabId - Tab where the prompt was detected.
 * @returns {Promise<void>} Promise resolved when auto extraction finishes.
 */
async function runAutoExtractForTab(detectedTabId) {
  // Avoid overlapping extraction attempts while the user is still typing.
  if (autoExtractInProgress) {
    return;
  }

  autoExtractInProgress = true;
  try {
    // Ensure the popup still points at the tab that raised the detection.
    var activeTabId = await getActiveTabId();
    if (activeTabId !== detectedTabId) {
      return;
    }

    await extractFromPage();
    await clearAutoExtractState(detectedTabId);
  } catch (error) {
    // Surface auto-extract failures without breaking manual controls.
    setStatus("Auto extract failed: " + error.message);
  } finally {
    // Allow future detections to trigger fresh extraction.
    autoExtractInProgress = false;
  }
}

/**
 * Handles prompt-detected messages while the popup is open.
 * @param {object} message - Runtime message payload.
 */
function handleRuntimeMessage(message) {
  // Route only auto-extract notifications intended for the current popup.
  if (!message || message.action !== "RUN_EXTRACT_FROM_PAGE") {
    return;
  }

  // Run asynchronously because Chrome message listeners are synchronous here.
  runAutoExtractForTab(message.tabId);
}

/**
 * Runs any pending auto extraction saved before the popup opened.
 * @returns {Promise<void>} Promise resolved after pending check.
 */
async function runPendingAutoExtract() {
  // Compare stored detection metadata with the active tab.
  var activeTabId = await getActiveTabId();
  var pendingAutoExtract = await getPendingAutoExtract();
  if (!shouldRunAutoExtract(pendingAutoExtract, activeTabId)) {
    return;
  }

  await runAutoExtractForTab(activeTabId);
}

/**
 * Handles the copy button click action.
 * @returns {Promise<void>} Promise resolved when copy flow finishes.
 */
async function handleCopyClick() {
  // Catch clipboard errors and keep popup responsive.
  try {
    await copyImprovedPrompt();
  } catch (error) {
    setStatus("Copy failed: " + error.message);
  }
}

/**
 * Handles the clear button click action.
 */
function handleClearClick() {
  // Reset all visible state for a fresh linting run.
  clearAll(true);
}

/**
 * Registers popup events and applies initial state.
 */
function initializePopup() {
  // Attach button handlers for linting, extraction, copy, and clear.
  document.getElementById("lintButton").addEventListener("click", lintCurrentPrompt);
  document.getElementById("extractButton").addEventListener("click", handleExtractClick);
  document.getElementById("copyButton").addEventListener("click", handleCopyClick);
  document.getElementById("clearButton").addEventListener("click", handleClearClick);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  // Prime status and default result display.
  clearAll(false);
  setStatus("Ready.");
  runPendingAutoExtract();
}

initializePopup();
