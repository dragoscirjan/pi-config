# AGENTS.md

## Coding Rules

Enforced automatically by the `pi-coder` extension's `detect_language` tool guidelines (see its `promptGuidelines`) whenever that extension is loaded — not duplicated here.

## Default MCP tool preferences

When solving user requests in this repo, prefer the following MCP servers by default:

1. **Codebase understanding / impact analysis**
   - Prefer `codeindex_gitnexus` for symbol lookup, context, execution flows, and impact checks before large refactors.

2. **Library/framework documentation**
   - Prefer `docs_context7` for current API usage and documentation lookups.

3. **Real-world usage patterns**
   - Prefer `docs_github_grep` when public-repo code examples are useful.

4. **Web search and web page fetching**
   - Prefer `webcrawl_searchable_web` for web discovery and page retrieval.
   - Reason: it converts HTML pages to Markdown, which is easier for the LLM to read and summarize accurately.

5. **Context Management and Data Extraction ("Think in Code") — use proactively, not just for "large" data**
   - Before reading multiple files, grepping broadly, or repeating similar file reads, use `memory_context` (context-mode) first.
   - Use `ctx_execute` for ANY log/data processing, not only when data is confirmed large — err on the side of using it to keep raw output out of context.
   - Use `ctx_index`/`ctx_search` at the start of any session that references prior work, before re-reading files from scratch.
   - Treat this as the default first move for repo exploration, not a fallback for edge cases.

## Behavior rules

- NEVER hallucinate. Answer based on real facts, motivate if possible. Keep it short and to the subject.
- Use `sequential_thinking` for ANY of the following, not just "clearly multi-step" tasks:
  - Any request involving 2+ distinct steps, files, or decisions.
  - Any debugging/root-cause task before proposing a fix.
  - Any architectural or refactor decision, even small ones.
  - Whenever you're about to second-guess or revise an earlier assumption mid-task.
  - Default to using it; skip only for single-fact lookups or trivial one-line edits.
- If an MCP/server is explicitly requested by the user, use it.
- If no tool is needed for a simple response, answer directly.
- Be concise in final responses.
- Mention MCP server names when needed, but do **not** prescribe specific MCP function names; let the agent discover/select functions.
