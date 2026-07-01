# Pi Configuration Overview

This repository contains a user-level Pi setup under `agent/`.

> Note: This README intentionally omits details about configured model providers.

## Directory Layout

- `agent/settings.json` — global Pi runtime settings
- `agent/mcp.json` — MCP gateway configuration
- `agent/models.json` — custom model/provider definitions (intentionally not documented here)
- `agent/auth.json` — authentication credentials/tokens
- `agent/agents/` — subagent definitions (Markdown frontmatter + prompts)
- `agent/extensions/` — custom Pi extensions
- `agent/sessions/` — persisted conversation histories

---

## Global Pi Settings (`agent/settings.json`)

Current behavior is configured to:

- Track last seen changelog version
- Use a high default thinking level
- Load the `pi-mcp-adapter` package

---

## MCP Configuration (`agent/mcp.json`)

### Global MCP Settings

- `toolPrefix`: `server`
- `idleTimeout`: `10` seconds

### Configured MCP Servers (by role)

- Browser automation
- Code index access
- GitHub repository/issues access (read-only)
- Documentation lookup
- Search over indexed web content
- Persistent memory server (writes to `${PROJECT_PATH}/.memory.jsonl`)
- Sequential-thinking helper

---

## Extensions

### 1) Bash Path Gate (`agent/extensions/bash-path-gate.ts`)

Adds a safety check for `bash` tool calls:

- Detects commands referencing paths outside the current working directory or `/tmp`
- Blocks automatically when no UI is available
- Prompts for approval in interactive sessions

### 2) Sandbox Extension (`agent/extensions/sandbox/` + `agent/extensions/sandbox.json`)

Wraps shell execution in OS-level sandboxing and applies filesystem policies.

Configured policy highlights:

- Enabled by default
- Read-deny patterns for sensitive directories/files (SSH keys, cloud creds, env files, etc.)
- Write-allow limited to current project and `/tmp`
- Write-deny patterns for secret/config artifacts and key files

### 3) Subagent Extension (`agent/extensions/subagent/`)

Provides a `subagent` tool supporting:

- Single-agent delegation
- Parallel delegation
- Chained delegation with `{previous}` output passing

Security behavior:

- Defaults to user-level agents
- Supports project-level agents only when explicitly requested
- Can require confirmation before running project-local agents

---

## Agent Definitions (`agent/agents/`)

Configured with multiple role-focused agents plus a Twig template example.

Key points:

- Agent definitions use frontmatter (`name`, `description`, optional tools/model fields)
- Prompt body acts as the system prompt for delegated runs
- `.md.twig` files are supported for templated prompts

---

## Session & State Files

- Sessions are stored under `agent/sessions/` as JSONL files
- MCP caches and OAuth artifacts are stored under:
  - `agent/mcp-cache.json`
  - `agent/mcp-npx-cache.json`
  - `agent/mcp-oauth/`

---

## Secrets & Git Hygiene

### Sensitive Files

- `agent/auth.json` contains auth material and is excluded from git
- File permissions are restricted (owner read/write)

### `.gitignore` Coverage

Ignored paths include:

- `agent/sessions/`
- `agent/auth.json`
- MCP cache/OAuth files
- local sqlite stash db

---

## How to Maintain This Setup

1. Edit config files under `agent/`
2. Reload Pi resources in-session with `/reload`
3. Keep secret-bearing files out of version control
4. Periodically review extension policies (path gate + sandbox) as your workflow evolves

---

## Quick Reference

- Main runtime settings: `agent/settings.json`
- MCP servers: `agent/mcp.json`
- Sandbox policy: `agent/extensions/sandbox.json`
- Subagents: `agent/agents/*.md`
- Extension code: `agent/extensions/**`
