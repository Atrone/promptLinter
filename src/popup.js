import { lintPrompt, buildImprovedPrompt } from "./linter.js";

var AUTO_EXTRACT_MAX_AGE_MS = 5 * 60 * 1000;
var autoExtractInProgress = false;
var currentPromptSelection = null;
var promptLintTimer = null;

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
 * Creates a card item describing hover-based lint resolution options.
 * @param {object} issue - Lint issue with resolution metadata.
 * @param {number} index - Display index for the issue.
 * @returns {HTMLLIElement} Rendered issue element.
 */
function createIssueAnnotationItem(issue, index) {
  // Build the card using DOM nodes so issue text remains safe.
  var item = document.createElement("li");
  item.className = "card";

  var heading = document.createElement("h3");
  heading.textContent = (index + 1) + ". " + issue.rule + " (" + String(issue.severity).toUpperCase() + ")";

  var paragraph = document.createElement("p");
  paragraph.textContent = issue.message + " Fix: " + issue.fix;

  var hint = document.createElement("p");
  hint.className = "card__annotation-hint";
  hint.textContent = "Hover the red underline in the annotated prompt to view resolution options.";

  item.appendChild(heading);
  item.appendChild(paragraph);
  item.appendChild(hint);
  return item;
}

/**
 * Collects underline ranges from lint issues.
 * @param {object} lintResult - Result payload returned by lintPrompt.
 * @returns {Array<object>} Non-overlapping annotation groups.
 */
function collectAnnotationGroups(lintResult) {
  // Flatten all issue highlights into a single range list.
  var groupsByRange = new Map();
  lintResult.issues.forEach(function collectIssue(issue) {
    (issue.highlights || []).forEach(function collectHighlight(highlight) {
      var key = highlight.start + ":" + highlight.end;
      var group = groupsByRange.get(key) || {
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

  // Sort and merge overlapping ranges so rendering stays valid.
  var groups = Array.from(groupsByRange.values()).sort(function sortByRange(a, b) {
    return a.start - b.start || b.end - a.end;
  });
  return groups.reduce(function mergeOverlaps(merged, group) {
    var previous = merged[merged.length - 1];
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
 * Creates a tooltip listing clickable lint resolution options.
 * @param {Array<string>} messages - Lint messages for this underline.
 * @param {Array<object>} options - Resolution options for this underline.
 * @returns {HTMLSpanElement} Rendered tooltip element.
 */
function createAnnotationTooltip(messages, options) {
  // Render a compact hover card with replacement choices.
  var tooltip = document.createElement("span");
  tooltip.className = "annotation__tooltip";
  tooltip.addEventListener("wheel", function handleTooltipWheel(event) {
    // Keep tooltip scrolling from moving the underlying editor.
    event.stopPropagation();
  });

  var title = document.createElement("strong");
  title.textContent = messages.filter(Boolean).join(" ");
  tooltip.appendChild(title);

  var seen = new Set();
  options.forEach(function renderOption(option) {
    var key = option.label + "::" + option.description;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    var button = document.createElement("button");
    button.type = "button";
    button.className = "annotation__suggestion";
    button.textContent = option.label + ": " + option.description;
    button.addEventListener("click", function handleSuggestionClick(event) {
      // Keep the click inside the tooltip from focusing the underlying textarea.
      event.preventDefault();
      event.stopPropagation();
      applySuggestionReplacement(option.replacement || "");
    });
    tooltip.appendChild(button);
  });
  return tooltip;
}

/**
 * Keeps an annotation tooltip open during forgiving pointer movement.
 * @param {HTMLElement} underline - Underlined text span.
 * @param {HTMLElement} tooltip - Tooltip shown for the underline.
 */
function wireStableAnnotationTooltip(underline, tooltip) {
  // Delay closing so moving from underline into the tooltip does not dismiss it.
  var closeTimer = null;

  /**
   * Opens the tooltip and cancels any pending close.
   */
  function openTooltip() {
    // Mark open state with a class so CSS controls display.
    window.clearTimeout(closeTimer);
    tooltip.classList.add("is-open");
  }

  /**
   * Closes the tooltip after a small grace period.
   */
  function scheduleCloseTooltip() {
    // A small delay tolerates diagonal mouse movement and internal scrolling.
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(function closeTooltip() {
      tooltip.classList.remove("is-open");
    }, 350);
  }

  // Keep the tooltip open while either element is hovered.
  underline.addEventListener("mouseenter", openTooltip);
  underline.addEventListener("mouseleave", scheduleCloseTooltip);
  tooltip.addEventListener("mouseenter", openTooltip);
  tooltip.addEventListener("mouseleave", scheduleCloseTooltip);

  // Keep keyboard focus transitions into tooltip buttons from closing it.
  underline.addEventListener("focusin", openTooltip);
  underline.addEventListener("focusout", function handleFocusOut(event) {
    if (!tooltip.contains(event.relatedTarget)) {
      scheduleCloseTooltip();
    }
  });
  tooltip.addEventListener("focusin", openTooltip);
  tooltip.addEventListener("focusout", function handleTooltipFocusOut(event) {
    if (!underline.contains(event.relatedTarget)) {
      scheduleCloseTooltip();
    }
  });
}

/**
 * Renders red underlines inside the prompt editor overlay.
 * @param {object} lintResult - Result payload returned by lintPrompt.
 */
function renderPromptEditorAnnotations(lintResult) {
  // Mirror textarea text in an overlay so the actual editor keeps focus and input.
  var container = document.getElementById("promptAnnotationLayer");
  var promptInput = document.getElementById("promptInput");
  var promptText = lintResult.normalizedPrompt || "";
  var groups = collectAnnotationGroups(lintResult);
  container.textContent = "";

  if (!promptText) {
    return;
  }

  // Append plain and annotated text spans in source order.
  var cursor = 0;
  groups.forEach(function renderGroup(group) {
    if (group.start > cursor) {
      container.appendChild(document.createTextNode(promptText.slice(cursor, group.start)));
    }

    var underline = document.createElement("span");
    var tooltip = createAnnotationTooltip(group.messages, group.options);
    underline.className = "annotation__underline";
    underline.tabIndex = 0;
    underline.textContent = promptText.slice(group.start, group.end);
    underline.appendChild(tooltip);
    wireStableAnnotationTooltip(underline, tooltip);
    container.appendChild(underline);
    cursor = group.end;
  });

  if (cursor < promptText.length) {
    container.appendChild(document.createTextNode(promptText.slice(cursor)));
  }

  // Keep overlay position aligned with textarea scrolling.
  container.scrollTop = promptInput.scrollTop;
  container.scrollLeft = promptInput.scrollLeft;
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
      issuesList.appendChild(createIssueAnnotationItem(issue, index));
    });
  }
  renderPromptEditorAnnotations(lintResult);

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
 * Applies replacement prompt text to the active page when available.
 * @param {string} promptText - Replacement prompt text.
 * @returns {Promise<void>} Promise resolved after page update attempt.
 */
async function applyPromptToActivePage(promptText) {
  // Only extracted prompts have a source selector on the page.
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
 * Applies a clicked suggestion replacement to the editor.
 * @param {string} replacement - Replacement prompt text.
 */
function applySuggestionReplacement(replacement) {
  // Ignore empty replacement payloads from malformed options.
  if (!replacement) {
    return;
  }

  // Update the actual textarea, rerun linting, and keep page source in sync.
  var promptInput = document.getElementById("promptInput");
  promptInput.value = replacement;
  var lintResult = lintPrompt(replacement);
  renderResults(lintResult, currentPromptSelection ? currentPromptSelection.source : "manual");
  setStatus("Suggestion applied.");
  applyPromptToActivePage(replacement).catch(function handleApplyError(error) {
    setStatus("Suggestion applied in popup. Page update failed: " + error.message);
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
              highlights: issue.highlights
            };
          })
        },
        selection: response.selection || null,
        promptText: lintResult.normalizedPrompt
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
  document.getElementById("promptAnnotationLayer").textContent = "";
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
 * Keeps annotation overlay aligned while the textarea scrolls.
 */
function syncPromptAnnotationScroll() {
  // Mirror textarea scroll offsets onto the annotation layer.
  var promptInput = document.getElementById("promptInput");
  var annotationLayer = document.getElementById("promptAnnotationLayer");
  annotationLayer.scrollTop = promptInput.scrollTop;
  annotationLayer.scrollLeft = promptInput.scrollLeft;
}

/**
 * Reruns linting shortly after the user edits the prompt.
 */
function handlePromptInputChange() {
  // Debounce linting so typing remains responsive.
  window.clearTimeout(promptLintTimer);
  promptLintTimer = window.setTimeout(function runLiveLint() {
    var promptText = document.getElementById("promptInput").value;
    if (!promptText.trim()) {
      clearAll(false);
      return;
    }
    renderResults(lintPrompt(promptText), currentPromptSelection ? currentPromptSelection.source : "manual");
  }, 350);
}

/**
 * Registers popup events and applies initial state.
 */
function initializePopup() {
  // Attach button handlers for linting, extraction, copy, and clear.
  var promptInput = document.getElementById("promptInput");
  document.getElementById("lintButton").addEventListener("click", lintCurrentPrompt);
  document.getElementById("extractButton").addEventListener("click", handleExtractClick);
  document.getElementById("copyButton").addEventListener("click", handleCopyClick);
  document.getElementById("clearButton").addEventListener("click", handleClearClick);
  promptInput.addEventListener("input", handlePromptInputChange);
  promptInput.addEventListener("scroll", syncPromptAnnotationScroll);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  // Prime status and default result display.
  clearAll(false);
  setStatus("Ready.");
  runPendingAutoExtract();
}

initializePopup();
