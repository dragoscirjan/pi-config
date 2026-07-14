# pi-coder

Language-context extension for coding workflows.

Its purpose is to make language-aware guidance explicit and persistent in the session state.

## Tool: `detect_language`

Input:

- `path` (string)

Output details:

- `language`
- `path`

Detection uses file extension mapping (`.ts` -> `typescript`, `.tsx` -> `tsx`, `.py` -> `python`, etc.). Unknown extension resolves to `unknown`.

## Session/state behavior

The extension maintains in-memory `currentLanguage/currentPath` and keeps state durable across session reloads:

- On each `detect_language`, it appends a custom entry:
  - `type: custom`
  - `customType: detected-language`
  - `data: { language, path }`
- On `session_start` and `session_tree`, it reconstructs latest state by scanning current branch entries and taking the newest `detected-language` entry.

## Prompt-guideline policy

`detect_language` includes workflow guidelines that require calling language detection before code writes/edits and then loading coding skill guidance in the same turn.

Important: this is instruction/policy guidance, not a runtime hard-block.

## Resource contribution

On `resources_discover`, extension contributes:

- `agent/extensions/pi-coder/skills`

This allows Pi to discover local skill resources.

In this repository, `pi-twig` can then render dynamic skill content (for example using `context.last_detected_language`) when `SKILL.md` is read.

## Extension map currently included

Mappings cover common web/backend/systems/data formats:

- JS/TS: `.js`, `.jsx`, `.ts`, `.tsx`
- scripting: `.sh`, `.bash`, `.ps1`
- backend: `.py`, `.go`, `.java`, `.cs`, `.php`, `.rb`, `.rs`
- config/data: `.json`, `.yaml`, `.yml`, `.xml`, `.sql`, `.md`
- others including: C/C++, Swift, Kotlin, Scala, Lua, Dart, GraphQL, Protobuf, Zig, Nim, and more.

## Development

From `agent/extensions/pi-coder`:

- `npm run lint`
- `npm run format`
- `npm run test`
