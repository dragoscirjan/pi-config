# pi-issue-tracking

Filesystem-based issue tracker extension for Pi.

It stores issues in a project-local `.issues/` folder as markdown files with YAML frontmatter.

## Tools

### `issue_create`

Creates an issue file with an auto-assigned 5-digit id.

Parameters:

- `type`: `initiative | epic | story | task | bug`
- `title`: issue title
- `description?`: optional body text
- `criteria?`: optional acceptance criteria text
- `status?`: `open | in_progress | done | closed` (default `open`)
- `parent?`: parent issue id
- `depends?`: comma-separated dependency ids
- `author?`: author attribution
- `assignee?`: assignee attribution

### `issue_list`

Lists issues from `.issues/`.

Filters:

- `status?`
- `type?`

### `issue_read`

Reads a single issue by id.

Parameter:

- `id`: 5-digit issue id

### `issue_comment`

Appends a structured update block to an issue.

Parameters:

- `id` (required)
- `update` (required)
- `artifacts?`
- `next_steps?`
- `blockers?`
- `author?`

## Format and naming

- Directory: `<cwd>/.issues`
- File naming: `{id}-{type}-{slug}.md`

Frontmatter includes id/type/title/status and optional parent/depends/author/assignee.

## Safety and robustness

- Atomic creation uses exclusive file open (`wx`) with retry on id collisions.
- Frontmatter values are escaped/sanitized for safe YAML serialization.
- On non-collision create failures, partial files are cleaned up best-effort.

## Development

From this extension directory:

- `npm run lint`
- `npm run format`
- `npm run typecheck`
- `npm run test`
