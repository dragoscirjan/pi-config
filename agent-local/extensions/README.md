# pi-twig Extension

## Intention

The `pi-twig` extension aims to introduce dynamic, configuration-driven compilation for Pi's resources (Skills, Agents, Prompts, etc.) using the [Twig](https://twig.symfony.com/) templating engine.

Traditionally, Pi relies on static Markdown files for defining Skills and System Prompts. When projects require dynamic context (e.g., "Use Git if $CVS_TOOL is git, else use Jujutsu"), the LLM often has to waste tokens and time actively executing tools like `bash` or `env-get` to figure out the current environment before it can begin the actual task.

By pre-compiling `.twig` templates into static `.md` files before Pi discovers them, we achieve:
1. **Zero-Confusion Prompts:** The LLM reads absolute facts (e.g., "The active tool is Git") rather than conditional logic.
2. **Token and Time Savings:** Eliminates the need for the LLM to run investigative CLI commands to understand project rules.
3. **Reusability:** A single Twig skill can be dropped into multiple projects, seamlessly adapting its content based on local `pi-twig.json` configuration files.

## What has been achieved so far

The core foundation is now fully operational:
* **Pre-discovery Compilation:** The extension runs synchronously in the extension factory during Pi's initialization. This guarantees that compilation finishes *before* Pi triggers `session_start` and `resources_discover`, ensuring the newly compiled `.md` files are ready for the system prompt build phase.
* **Skill Resolution:** Automatically scans standard agent and project directories for `**/*.md.twig` files (e.g., `~/.pi/agent/skills/`, `./.pi/skills/`, `./skills/`).
* **Configuration Loading:** Locates, parses, and merges context from `pi-twig.json` files found in the home directory (`~/.pi/pi-twig.json`) and the current working directory (`./.pi/pi-twig.json`, `./pi-twig.json`).
* **Twig Rendering Context:** Injects the loaded JSON configuration alongside built-in system variables (`os`, `arch`, `cwd`, `homedir`).
* **ESM/TypeScript Setup:** The extension is correctly configured as an ES Module using standard TypeScript tooling.

## What needs to be done further

To fully integrate Twig into Pi's core functionalities and unlock its maximum potential, the following enhancements are planned:

1. **Watch Mode / Hot Reloading**
   * *Issue:* Currently, compilation only happens when Pi starts. If a user modifies `pi-twig.json` or a `.twig` file mid-session, Pi won't see the changes.
   * *Action:* Implement a file watcher on the config files and `*.twig` files to dynamically recompile and re-trigger Pi's resource discovery without restarting the session.

2. **Intercepting the `read` Tool**
   * *Issue:* If the LLM uses the `read` tool on `SKILL.md.twig`, it sees the raw template rather than the compiled output.
   * *Action:* Hook into Pi's tool execution lifecycle. When the LLM attempts to read a `.twig` file, intercept the call and return the compiled output to prevent confusion.

3. ~~**Broader Resource Support**~~
   * ~~*Issue:* Right now, it strictly compiles `*.md.twig` to `*.md` for Skills.~~
   * ~~*Action:* Expand support to custom Agent definitions (`agent.json.twig`), themes, and prompt templates, allowing developers to parameterize the entire Pi ecosystem.~~

4. **Custom Twig Functions and Filters**
   * *Issue:* The context is limited to static variables loaded from JSON.
   * *Action:* Register custom Twig functions that execute logic during compilation. For example: `{{ execute('git branch --show-current') }}`, `{{ readFile('package.json') | parse_json }}`, or `{{ has_dependency('react') ? 'React mode' : 'Vanilla mode' }}`.

5. **Error Reporting and TUI Integration**
   * *Issue:* Twig syntax errors or missing variables currently throw silent warnings to the console.
   * *Action:* Route compilation errors through Pi's Extension API to display them natively in the Terminal User Interface (TUI), alerting the user immediately if a template fails to compile.
