# AGENTS.md

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

5. **Context Management and Data Extraction ("Think in Code")**
   - Prefer `memory_context` (context-mode) for operations involving large data sets, log analysis, or repetitive file reads.
   - Use `ctx_execute` to run scripts that process data locally and only return relevant summaries, keeping raw data out of the context window.
   - Use `ctx_index` and `ctx_search` for persistent session memory and retrieval.

## Behavior rules

- If a task is clearly multi-step, use `sequential_thinking` first.
- If an MCP/server is explicitly requested by the user, use it.
- If no tool is needed for a simple response, answer directly.
- Be concise in final responses.
- Mention MCP server names when needed, but do **not** prescribe specific MCP function names; let the agent discover/select functions.
