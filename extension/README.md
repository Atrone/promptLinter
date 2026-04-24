# Prompt Linter Chrome Extension

Lint and improve prompts from web pages directly in your browser.

## Features

- Prompt quality score (`0-100`)
- Rule-based lint checks with severity levels (`high`, `medium`, `low`)
- One-click suggestions to improve weak prompts
- Automatic prompt discovery from:
  - currently selected text
  - focused textareas / editable fields
  - large text blocks on page

## Project Structure

```text
extension/
  manifest.json
  src/
    background.js
    content.js
    linter.js
    popup.css
    popup.html
    popup.js
```

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension` folder.

## Usage

1. Open any page containing prompt text.
2. Click the **Prompt Linter** extension icon.
3. Review:
   - score
   - issues
   - suggestions
4. Optionally copy the improved prompt.

## Rules Included

- Prompt is non-empty and sufficiently specific
- Explicit role/persona is present
- Concrete task objective exists
- Output format is specified
- Constraints are included
- Context or inputs are provided
- Ambiguous terms are discouraged

## Future Improvements

- Custom rules per team
- Site-specific prompt extraction profiles
- Export lint reports
- In-page overlay for inline suggestions
