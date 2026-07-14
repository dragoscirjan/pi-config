# pi-issue-tracking

Filesystem issue tracker extension for Pi, backed by markdown files in `.issues/`.

This extension is intentionally file-centric: issues are human-readable, versionable, and scriptable without external APIs.

## Data model

### Types

- `initiative`
- `epic`
- `story`
- `task`
- `bug`

### Status

- `open`
- `in_progress`
- `done`
- `closed`

### File location + naming

- directory: `<cwd>/.issues`
- filename: `{id}-{type}-{slug}.md`
- id format: zero-padded 5-digit string (e.g. `00042`)

## Tools

### `issue_create`

Creates a new issue document.

Parameters:

- `type` (required)
- `title` (required)
- `description?`
- `criteria?`
- `status?`
- `parent?`
- `depends?` (comma-separated)
- `author?`
- `assignee?`

Behavior:

- allocates next id from existing files,
- writes YAML frontmatter + typed body template,
- includes issue-type-specific sections (bug/scoped/technical variants).

### `issue_list`

Lists issues with optional filters:

- `status?`
- `type?`

Output includes `[id] <emoji> <type> | <status> | <title>` rows.

### `issue_read`

Reads full markdown content for one issue by `id`.

### `issue_comment`

Appends a dated update block to an issue with optional artifacts/next steps/blockers.

## Frontmatter behavior

Frontmatter fields include:

- required: `id`, `type`, `title`, `status`
- optional: `parent`, `depends`, `opencode-agent`, `opencode-assignee`

Serialization/parsing safeguards:

- single-quote escaping for YAML-safe values,
- newline stripping for single-line metadata fields,
- quote-aware frontmatter parse helper used by list/read flows.

## Concurrency and failure handling

- Issue creation uses `openSync(filepath, 'wx')` for atomic file creation.
- On id collision (`EEXIST`), creation retries with a fresh id.
- On non-collision write failure, partial file is removed best-effort before rethrow.

## Body template behavior

Generated issue body always includes:

- title heading with type emoticon
- `Description`
- type-specific section block:
  - bug: reproduce / expected / actual
  - initiative|epic|story: scope/goals/risks
  - task: technical requirements
- `Acceptance Criteria`
- `Comments`

## Development

From `agent/extensions/pi-issue-tracking`:

- `npm run lint`
- `npm run format`
- `npm run typecheck`
- `npm run test`
