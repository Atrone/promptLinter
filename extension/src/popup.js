import { lintPrompt, buildImprovedPrompt } from "./linter.js";

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
      issuesList.appendChild(
        createListItem(
          (index + 1) + ". " + issue.rule + " (" + String(issue.severity).toUpperCase() + ")",
          issue.message + " Fix: " + issue.fix
        )
      );
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
  renderResults(lintResult, "manual");
  setStatus("Lint complete.");
  return lintResult;
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
              severity: issue.severity
            };
          })
        }
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

  // Prime status and default result display.
  clearAll(false);
  setStatus("Ready.");
}

initializePopup();
