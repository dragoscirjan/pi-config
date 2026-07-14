# Pi Issue Tracking Extension

A robust, filesystem-based issue tracking extension for the `pi` coding agent. This extension automates the creation, management, and documentation of development tasks using a structured markdown-based workflow.

## Table of Contents

- [Overview](#overview)
- [Hierarchy & Emoticons](#hierarchy--emoticons)
- [Tools](#tools)
  - [issue_create](#issue_create)
  - [issue_list](#issue_list)
  - [issue_read](#issue_read)
  - [issue_comment](#issue_comment)
- [File Structure](#file-structure)
- [Templates & Gherkin](#templates--gherkin)
- [Installation & Configuration](#installation--configuration)
- [Development](#development)

## Overview

The Pi Issue Tracking extension replaces legacy manual workflows with an automated, schema-driven system. It stores issues as Markdown files in a local `.issues/` directory, making them easily searchable, version-controllable, and readable by both humans and agents.

Key improvements over legacy systems:

- **Automatic ID Assignment**: Generates zero-padded 5-digit IDs (e.g., `00001`).
- **Contextual Templates**: Automatically populates files with headers specific to the issue type (Bug, Story, Task, etc.).
- **Visual Hierarchy**: Uses standardized emoticons for quick identification.
- **Structured Comments**: Provides a specialized tool for status updates, artifact tracking, and blocker reporting.

## Hierarchy & Emoticons

The extension uses a specific hierarchy to organize project scope, each associated with a unique emoticon:

| Icon | Type           | Description                                                  |
| :--- | :------------- | :----------------------------------------------------------- |
| 🚀   | **Initiative** | High-level strategic goals or large project phases.          |
| 🏔️   | **Epic**       | Large bodies of work that can be broken down into stories.   |
| 📖   | **Story**      | User-centric requirements (As a... I want to... So that...). |
| 🛠️   | **Task**       | Technical implementation details and specific dev work.      |
| 🐛   | **Bug**        | Defects or unexpected behaviors needing a fix.               |

## Tools

### issue_create

Creates a new issue file with an auto-assigned ID and appropriate template.

**Parameters:**

- `type`: `initiative` | `epic` | `story` | `task` | `bug` (Required)
- `title`: Short summary of the issue (Required)
- `description`: Detailed context or user story.
- `criteria`: Initial list of acceptance criteria.
- `status`: `open` | `in_progress` | `done` | `closed` (Default: `open`)
- `parent`: ID of the parent issue (for hierarchy).
- `depends`: Comma-separated list of blocking IDs.
- `author`: Attribution for the creator.
- `assignee`: Attribution for the owner.

### issue_list

Lists issues from the `.issues/` directory with optional filtering.

**Parameters:**

- `status`: Filter by status.
- `type`: Filter by issue type.

### issue_read

Retrieves the full content of an issue.

**Parameters:**

- `id`: The 5-digit ID (e.g., `"00005"`).

### issue_comment

Appends a structured status update to an existing issue.

**Parameters:**

- `id`: Target issue ID.
- `update`: The core status update/description.
- `artifacts`: Links to PRs, files, or logs.
- `next_steps`: Planned follow-up actions.
- `blockers`: Current items stalling progress.

## File Structure

Issues are stored in the `.issues/` directory at the project root using the following naming convention:
`{ID}-{TYPE}-{SLUG}.md`

Example: `.issues/00042-bug-fix-header-alignment.md`

## Templates & Gherkin

The extension automatically injects boilerplate content based on the `type`:

- **Gherkin Format**: All Stories and Epics include a template for "As a... I want to... So that...".
- **Bug Reports**: Automatically include sections for "Steps to Reproduce", "Expected Behavior", and "Actual Behavior".
- **Tasks**: Include a "Technical Requirements" section.
- **Acceptance Criteria**: All issues include a checklist section for verification.

## Installation & Configuration

To enable the extension, add it to your `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["./extensions/pi-issue-tracking"]
}
```

## Development

The extension is written in TypeScript and uses `typebox` for schema validation.

1. **Source**: `index.ts`
2. **Build**: Run `npx tsc` in the extension directory to generate `index.js`.
3. **Dependencies**: Requires `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai`.
