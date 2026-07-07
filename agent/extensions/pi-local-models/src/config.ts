import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalModelsConfig } from "./types.js";
import { logWarn } from "./log.js";

const EMPTY_CONFIG: LocalModelsConfig = { backends: {} };

/**
 * Resolve the config directory the same way Pi's own CLI does: honor the
 * `PI_CODING_AGENT_DIR` env var (used to run multiple isolated profiles,
 * e.g. `agent-local`), falling back to the global `~/.pi/agent` directory.
 * Must NOT use `os.homedir()` unconditionally — that ignores the env var
 * and always resolves to the global profile, which was a real bug (local
 * profiles silently loaded zero backends).
 */
function getConfigPath(): string {
  const baseDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(baseDir, "local-models.json");
}

/**
 * Load and parse `local-models.json` from the active Pi profile directory
 * (see `getConfigPath`). Re-read on every sync cycle (mirrors Pi's own
 * `models.json` hot-reload behavior, no restart needed for config edits).
 * Never throws — missing file or malformed JSON both fall back to an empty
 * config (no backends configured).
 */
export function loadConfig(): LocalModelsConfig {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        backends: parsed.backends ?? {},
        rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      };
    }
  } catch (error) {
    logWarn(`failed to read config at ${configPath}`, error);
  }
  return EMPTY_CONFIG;
}

/**
 * Resolve a single value: "$ENV_VAR" / "${ENV_VAR}" interpolation, "$$" -> "$"
 * escape, otherwise treated as a literal. Missing env vars leave the value
 * unresolved (returned as-is), matching Pi's own documented behavior.
 */
export function resolveValue(value: string): string {
  if (value === "$$") return "$";
  if (value.startsWith("${") && value.endsWith("}")) {
    const envKey = value.slice(2, -1);
    return process.env[envKey] ?? value;
  }
  if (value.startsWith("$") && !value.startsWith("$$")) {
    const envKey = value.slice(1);
    return process.env[envKey] ?? value;
  }
  return value;
}

/**
 * Resolve a `ServerEntry.headers[]` array of raw "Name: Value" lines into a
 * `Record<string,string>` suitable for `ProviderConfig.headers`. Each value
 * portion supports `$ENV_VAR`/`${ENV_VAR}` interpolation via `resolveValue`.
 * Malformed entries (no `:`) are skipped with a warning. Shell-command
 * (`!command`) resolution is out of scope for v1.
 */
export function resolveHeaders(headers: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;

  for (const line of headers) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      logWarn(`malformed header entry (missing ':'), skipping: ${line}`);
      continue;
    }
    const name = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    if (!name) {
      logWarn(`malformed header entry (empty name), skipping: ${line}`);
      continue;
    }
    result[name] = resolveValue(rawValue);
  }

  return result;
}
