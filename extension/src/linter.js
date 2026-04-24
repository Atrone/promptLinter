/**
 * Normalizes prompt text into a safe trimmed string.
 * @param {string} promptText - Raw prompt text value.
 * @returns {string} Safe normalized prompt text.
 */
function normalizePrompt(promptText) {
  // Coerce unknown values so the linter never crashes on null input.
  return String(promptText || "").trim();
}

/**
 * Creates a structured issue object for rule failures.
 * @param {string} rule - Rule identifier.
 * @param {"high"|"medium"|"low"} severity - Issue severity.
 * @param {string} message - Human readable issue message.
 * @param {string} fix - Recommended prompt improvement.
 * @returns {{rule:string,severity:string,message:string,fix:string}} Lint issue object.
 */
function createIssue(rule, severity, message, fix) {
  // Keep issue shape consistent for popup rendering.
  return {
    rule,
    severity,
    message,
    fix
  };
}

/**
 * Checks whether a prompt includes persona or role framing.
 * @param {string} promptText - Normalized prompt text.
 * @returns {boolean} True when a role signal is present.
 */
function hasRoleSignal(promptText) {
  // Match common role directives used in prompting.
  return /(^|\b)(you are|act as|as a|as an|role:|behave like)/i.test(promptText);
}

/**
 * Checks whether a prompt includes explicit constraints.
 * @param {string} promptText - Normalized prompt text.
 * @returns {boolean} True when constraint signal is present.
 */
function hasConstraintSignal(promptText) {
  // Detect guardrail keywords that narrow model behavior.
  return /\b(must|do not|don't|avoid|limit|at most|no more than|exactly|required)\b/i.test(promptText);
}

/**
 * Checks whether a prompt requests a clear output format.
 * @param {string} promptText - Normalized prompt text.
 * @returns {boolean} True when output-format signal is present.
 */
function hasFormatSignal(promptText) {
  // Detect common format requests for machine- and human-readable output.
  return /\b(json|yaml|markdown|table|bullet|numbered list|csv|schema|format)\b/i.test(promptText);
}

/**
 * Checks whether a prompt includes contextual details.
 * @param {string} promptText - Normalized prompt text.
 * @returns {boolean} True when context signal is present.
 */
function hasContextSignal(promptText) {
  // Match words that usually add domain context and assumptions.
  return /\b(context|background|audience|given|assume|about|using|for)\b/i.test(promptText);
}

/**
 * Checks whether a prompt includes a clear objective verb.
 * @param {string} promptText - Normalized prompt text.
 * @returns {boolean} True when objective signal is present.
 */
function hasObjectiveSignal(promptText) {
  // Match verbs that typically describe an explicit task.
  return /\b(build|create|write|analyze|summarize|design|compare|explain|generate|refactor)\b/i.test(promptText);
}

/**
 * Calculates score impact from lint issues.
 * @param {Array<{severity:string}>} issues - Linter issue array.
 * @returns {number} Score between 0 and 100.
 */
function computeScore(issues) {
  // Initialize score to perfect and apply weighted deductions.
  let score = 100;
  const weights = { high: 20, medium: 12, low: 6 };

  // Subtract the configured weight for each issue.
  issues.forEach((issue) => {
    score -= weights[issue.severity] || 0;
  });

  // Clamp the final score to a valid display range.
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Calculates highest-severity label from lint issues.
 * @param {Array<{severity:string}>} issues - Linter issue array.
 * @returns {"high"|"medium"|"low"|"none"} Overall severity label.
 */
function computeOverallSeverity(issues) {
  // Return "none" when no issues exist.
  if (!issues.length) {
    return "none";
  }

  // Prioritize the most severe issue level.
  if (issues.some((issue) => issue.severity === "high")) {
    return "high";
  }

  // Fall back to medium severity.
  if (issues.some((issue) => issue.severity === "medium")) {
    return "medium";
  }

  // Remaining issues are low severity.
  return "low";
}

/**
 * Builds a summary sentence from lint findings.
 * @param {Array<{severity:string}>} issues - Linter issue array.
 * @returns {string} Human-readable summary text.
 */
function buildSummary(issues) {
  // Report success immediately when there are no issues.
  if (!issues.length) {
    return "Strong prompt: role, context, constraints, and output format look clear.";
  }

  // Count findings by severity for quick status context.
  const high = issues.filter((issue) => issue.severity === "high").length;
  const medium = issues.filter((issue) => issue.severity === "medium").length;
  const low = issues.filter((issue) => issue.severity === "low").length;
  return `Found ${high} high, ${medium} medium, and ${low} low priority improvements.`;
}

/**
 * Builds a structured improved prompt template.
 * @param {string} promptText - Raw prompt text from the user.
 * @returns {string} Improved prompt suggestion.
 */
function buildImprovedPrompt(promptText) {
  // Normalize input once before generating template sections.
  const normalizedPrompt = normalizePrompt(promptText) || "Describe the task clearly.";

  // Compose a reusable template that enforces prompt structure.
  return [
    "Role:",
    "You are an expert assistant in this domain.",
    "",
    "Goal:",
    normalizedPrompt,
    "",
    "Context:",
    "Audience: [who this is for]",
    "Background: [relevant facts, constraints, and assumptions]",
    "",
    "Requirements:",
    "- Include concrete steps or recommendations.",
    "- Cite assumptions when information is missing.",
    "- Keep the answer concise and actionable.",
    "",
    "Output format:",
    "Return markdown with sections: Summary, Details, Next Steps."
  ].join("\n");
}

/**
 * Runs all lint rules and returns scoring plus suggestions.
 * @param {string} promptText - Raw prompt text to lint.
 * @returns {{
 *   normalizedPrompt:string,
 *   score:number,
 *   severity:string,
 *   summary:string,
 *   issues:Array<object>,
 *   suggestions:Array<string>,
 *   improvedPrompt:string
 * }} Prompt linting result.
 */
function lintPrompt(promptText) {
  // Normalize input early so all checks operate on the same value.
  const normalizedPrompt = normalizePrompt(promptText);
  const issues = [];
  const sentenceCount = normalizedPrompt.split(/[.!?]\s+/).filter(Boolean).length;

  // Flag empty prompts as an immediate high-severity issue.
  if (!normalizedPrompt) {
    issues.push(
      createIssue(
        "empty-prompt",
        "high",
        "Prompt is empty.",
        "Start with the task objective, then add context, constraints, and output format."
      )
    );
  }

  // Detect under-specified prompt length.
  if (normalizedPrompt && normalizedPrompt.length < 35) {
    issues.push(
      createIssue(
        "prompt-too-short",
        "high",
        "Prompt is too short to be reliably interpreted.",
        "Add domain context, required depth, and success criteria."
      )
    );
  }

  // Detect unstructured prompts that lack multi-sentence context.
  if (normalizedPrompt && sentenceCount < 2) {
    issues.push(
      createIssue(
        "low-structure",
        "medium",
        "Prompt has little structure.",
        "Use sections such as Role, Goal, Constraints, and Output Format."
      )
    );
  }

  // Check for missing role framing.
  if (normalizedPrompt && !hasRoleSignal(normalizedPrompt)) {
    issues.push(
      createIssue(
        "missing-role",
        "medium",
        "No role or persona instruction detected.",
        "Add a role statement, for example: \"You are a senior product analyst.\""
      )
    );
  }

  // Check for missing objective signal.
  if (normalizedPrompt && !hasObjectiveSignal(normalizedPrompt)) {
    issues.push(
      createIssue(
        "missing-objective",
        "medium",
        "Task objective is unclear.",
        "Use a clear action verb such as build, analyze, compare, or explain."
      )
    );
  }

  // Check for missing context.
  if (normalizedPrompt && !hasContextSignal(normalizedPrompt)) {
    issues.push(
      createIssue(
        "missing-context",
        "medium",
        "Context or audience details are missing.",
        "Add background details and who the output is intended for."
      )
    );
  }

  // Check for missing constraints.
  if (normalizedPrompt && !hasConstraintSignal(normalizedPrompt)) {
    issues.push(
      createIssue(
        "missing-constraints",
        "low",
        "No explicit constraints detected.",
        "Specify boundaries such as length, exclusions, and required inclusions."
      )
    );
  }

  // Check for missing output format guidance.
  if (normalizedPrompt && !hasFormatSignal(normalizedPrompt)) {
    issues.push(
      createIssue(
        "missing-output-format",
        "medium",
        "Output format is not specified.",
        "Request a concrete format like JSON, table, bullets, or markdown sections."
      )
    );
  }

  // Check for vague language that weakens precision.
  if (/\b(stuff|things|something|maybe|etc)\b/i.test(normalizedPrompt)) {
    issues.push(
      createIssue(
        "vague-language",
        "low",
        "Prompt contains ambiguous wording.",
        "Replace vague terms with measurable requirements and examples."
      )
    );
  }

  // Build unique suggestions list from issue fixes.
  const suggestions = [...new Set(issues.map((issue) => issue.fix))];
  return {
    normalizedPrompt,
    score: computeScore(issues),
    severity: computeOverallSeverity(issues),
    summary: buildSummary(issues),
    issues,
    suggestions,
    improvedPrompt: buildImprovedPrompt(normalizedPrompt)
  };
}

export { lintPrompt, buildImprovedPrompt };

/**
 * Registers window-scoped API for non-module consumers.
 */
function registerLinterWindowApi() {
  // Skip global registration when running outside browser contexts.
  if (typeof window === "undefined") {
    return;
  }

  // Expose linter methods globally for popup runtime access.
  window.PromptLinter = {
    lintPrompt: lintPrompt,
    buildImprovedPrompt: buildImprovedPrompt
  };
}

registerLinterWindowApi();
