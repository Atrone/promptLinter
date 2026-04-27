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
 * @param {{label:string,description:string,replacement:string}} action - Hover resolution guidance.
 * @returns {{rule:string,severity:string,message:string,fix:string,action:object,highlights:Array<object>}} Lint issue object.
 */
function createIssue(rule, severity, message, fix, action) {
  // Keep issue shape consistent for popup rendering.
  return {
    rule,
    severity,
    message,
    fix,
    action,
    highlights: []
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
 * Adds a structured section to the end of a prompt.
 * @param {string} promptText - Current prompt text.
 * @param {string} heading - Section heading to append.
 * @param {Array<string>} lines - Section body lines.
 * @returns {string} Prompt text with the appended section.
 */
function appendPromptSection(promptText, heading, lines) {
  // Normalize spacing before adding a new improvement block.
  const normalizedPrompt = normalizePrompt(promptText);
  const section = [heading].concat(lines).join("\n");

  // Return just the section when the original prompt is empty.
  if (!normalizedPrompt) {
    return section;
  }

  // Separate the new section clearly from existing prompt text.
  return normalizedPrompt + "\n\n" + section;
}

/**
 * Replaces vague wording with more specific placeholders.
 * @param {string} promptText - Current prompt text.
 * @returns {string} Prompt text with vague terms clarified.
 */
function replaceVagueLanguage(promptText) {
  // Swap common vague terms for concrete language prompts.
  const replacements = {
    stuff: "specific details",
    things: "requirements",
    something: "a concrete outcome",
    maybe: "when appropriate",
    etc: "named additional requirements"
  };

  // Preserve the rest of the user's prompt while changing only weak terms.
  return normalizePrompt(promptText).replace(/\b(stuff|things|something|maybe|etc)\b/gi, (match) => {
    return replacements[match.toLowerCase()] || match;
  });
}

/**
 * Builds a hover resolution option for a lint issue.
 * @param {string} rule - Rule identifier.
 * @param {string} promptText - Current prompt text.
 * @returns {{label:string,description:string,replacement:string}} Fix option for UI hover cards.
 */
function buildIssueAction(rule, promptText) {
  // Normalize once so replacements are deterministic.
  const normalizedPrompt = normalizePrompt(promptText);

  // Build a deterministic rewrite for each rule.
  if (rule === "empty-prompt") {
    return {
      label: "Insert starter prompt",
      description: "Start with Role, Goal, Context, Requirements, and Output Format sections.",
      replacement: buildImprovedPrompt("")
    };
  }

  if (rule === "prompt-too-short") {
    return {
      label: "Add detail placeholders",
      description: "Add context, success criteria, and expected depth.",
      replacement: appendPromptSection(normalizedPrompt, "Details to include:", [
        "- Context: [describe the situation and audience].",
        "- Success criteria: [describe what a good answer must include].",
        "- Depth: Keep the answer concise but include concrete next steps."
      ])
    };
  }

  if (rule === "low-structure") {
    return {
      label: "Convert to structured prompt",
      description: "Wrap the prompt in Role, Goal, Context, Requirements, and Output Format sections.",
      replacement: buildImprovedPrompt(normalizedPrompt)
    };
  }

  if (rule === "missing-role") {
    return {
      label: "Add role",
      description: "Add a sentence such as: You are an expert assistant in this domain.",
      replacement: "You are an expert assistant in this domain.\n\n" + normalizedPrompt
    };
  }

  if (rule === "missing-objective") {
    return {
      label: "Clarify objective",
      description: "Add a clear action verb and state the expected outcome.",
      replacement: appendPromptSection(normalizedPrompt, "Task objective:", [
        "Analyze the request and provide a clear, useful response."
      ])
    };
  }

  if (rule === "missing-context") {
    return {
      label: "Add context",
      description: "Describe the audience, background, assumptions, and source material.",
      replacement: appendPromptSection(normalizedPrompt, "Context:", [
        "Audience: General readers.",
        "Background: Use the information in the prompt and state assumptions when details are missing."
      ])
    };
  }

  if (rule === "missing-constraints") {
    return {
      label: "Add constraints",
      description: "Add boundaries for length, exclusions, required inclusions, and assumptions.",
      replacement: appendPromptSection(normalizedPrompt, "Requirements:", [
        "- Keep the answer concise and actionable.",
        "- Avoid unsupported claims.",
        "- Include assumptions when information is missing."
      ])
    };
  }

  if (rule === "missing-output-format") {
    return {
      label: "Add output format",
      description: "Request a concrete response shape like JSON, a table, bullets, or markdown sections.",
      replacement: appendPromptSection(normalizedPrompt, "Output format:", [
        "Return markdown with sections: Summary, Details, and Next Steps."
      ])
    };
  }

  if (rule === "vague-language") {
    return {
      label: "Clarify vague wording",
      description: "Replace vague terms with measurable requirements, named examples, or specific constraints.",
      replacement: replaceVagueLanguage(normalizedPrompt)
    };
  }

  // Fall back to the full prompt scaffold for unknown rule actions.
  return {
    label: "Improve prompt",
    description: "Use the structured prompt template to make the request clearer.",
    replacement: buildImprovedPrompt(normalizedPrompt)
  };
}

/**
 * Builds hover-only resolution options for an issue.
 * @param {object} issue - Lint issue with fix and action text.
 * @returns {Array<{label:string,description:string,replacement:string}>} Resolution options for tooltip rendering.
 */
function buildResolutionOptions(issue) {
  // Keep options descriptive instead of mutating the prompt automatically.
  const options = [
    {
      label: issue.action && issue.action.label ? issue.action.label : "Improve prompt",
      description: issue.action && issue.action.description ? issue.action.description : issue.fix,
      replacement: issue.action && issue.action.replacement ? issue.action.replacement : ""
    },
    {
      label: "Manual edit",
      description: issue.fix,
      replacement: issue.action && issue.action.replacement ? issue.action.replacement : ""
    }
  ];

  // Remove duplicate descriptions so hover cards stay compact.
  const seen = new Set();
  return options.filter((option) => {
    const key = option.label + "::" + option.description;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Finds vague language ranges in the prompt.
 * @param {string} promptText - Normalized prompt text.
 * @returns {Array<{start:number,end:number}>} Matched vague word ranges.
 */
function findVagueLanguageRanges(promptText) {
  // Underline each vague term directly when possible.
  const ranges = [];
  const matcher = /\b(stuff|things|something|maybe|etc)\b/gi;
  let match = matcher.exec(promptText);
  while (match) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length
    });
    match = matcher.exec(promptText);
  }
  return ranges;
}

/**
 * Builds a fallback prompt range for conceptual lint issues.
 * @param {string} promptText - Normalized prompt text.
 * @returns {{start:number,end:number} | null} Range to underline, or null.
 */
function getPromptHighlightRange(promptText) {
  // Missing structural pieces apply to the authored prompt as a whole.
  if (!promptText) {
    return null;
  }
  return {
    start: 0,
    end: promptText.length
  };
}

/**
 * Adds hover annotation ranges to an issue.
 * @param {object} issue - Lint issue to annotate.
 * @param {string} promptText - Normalized prompt text.
 * @returns {object} Issue with highlight metadata.
 */
function annotateIssue(issue, promptText) {
  // Build tooltip text once so each highlighted range has the same options.
  const options = buildResolutionOptions(issue);
  const ranges = issue.rule === "vague-language" ? findVagueLanguageRanges(promptText) : [getPromptHighlightRange(promptText)];

  // Convert valid ranges into UI-friendly highlights.
  issue.highlights = ranges
    .filter((range) => range && range.end > range.start)
    .map((range) => ({
      start: range.start,
      end: range.end,
      rule: issue.rule,
      severity: issue.severity,
      message: issue.message,
      options
    }));

  return issue;
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
        "Start with the task objective, then add context, constraints, and output format.",
        buildIssueAction("empty-prompt", normalizedPrompt)
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
        "Add domain context, required depth, and success criteria.",
        buildIssueAction("prompt-too-short", normalizedPrompt)
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
        "Use sections such as Role, Goal, Constraints, and Output Format.",
        buildIssueAction("low-structure", normalizedPrompt)
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
        "Add a role statement, for example: \"You are a senior product analyst.\"",
        buildIssueAction("missing-role", normalizedPrompt)
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
        "Use a clear action verb such as build, analyze, compare, or explain.",
        buildIssueAction("missing-objective", normalizedPrompt)
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
        "Add background details and who the output is intended for.",
        buildIssueAction("missing-context", normalizedPrompt)
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
        "Specify boundaries such as length, exclusions, and required inclusions.",
        buildIssueAction("missing-constraints", normalizedPrompt)
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
        "Request a concrete format like JSON, table, bullets, or markdown sections.",
        buildIssueAction("missing-output-format", normalizedPrompt)
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
        "Replace vague terms with measurable requirements and examples.",
        buildIssueAction("vague-language", normalizedPrompt)
      )
    );
  }

  // Attach text ranges used by hover annotations.
  const annotatedIssues = issues.map((issue) => annotateIssue(issue, normalizedPrompt));

  // Build unique suggestions list from issue fixes.
  const suggestions = [...new Set(annotatedIssues.map((issue) => issue.fix))];
  return {
    normalizedPrompt,
    score: computeScore(annotatedIssues),
    severity: computeOverallSeverity(annotatedIssues),
    summary: buildSummary(annotatedIssues),
    issues: annotatedIssues,
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
