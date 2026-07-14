# pi-coder

Language detection extension used to provide language-aware coding guidance.

## Tool

### `detect_language`

Detects language from file extension, stores the result in session state, and returns detected details.

Input:

- `path` (file path)

Output details:

- `language`
- `path`

## Behavior

- Maintains latest detected language/path in extension state.
- Reconstructs state on `session_start` and `session_tree` by scanning branch custom entries (`customType: detected-language`).
- Appends a custom session entry each time `detect_language` runs.
- Publishes local skill path during `resources_discover`:
  - `agent/extensions/pi-coder/skills`

This is used with `pi-twig` to render dynamic coding guidance based on the last detected language.

## Supported extensions

Includes mappings for major languages and file types (`.ts`, `.tsx`, `.js`, `.py`, `.go`, `.rs`, `.java`, `.cs`, `.json`, `.yaml`, `.md`, `.sql`, etc.). Unknown extensions return `unknown`.

## Development

From this extension directory:

- `npm run lint`
- `npm run format`
- `npm run test`
