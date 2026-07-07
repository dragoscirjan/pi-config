import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";

/** Local model backends supported by this extension. */
export type BackendName = "lmstudio" | "ollama" | "llamacpp" | "mlx";

/** A single server entry for a backend, as configured in `~/.pi/agent/local-models.json`. */
export interface ServerEntry {
  /** Server label, used in the provider name when multiple servers are configured for a backend. */
  name?: string;
  /** Base URL of the running server, e.g. "http://127.0.0.1:1234". */
  url: string;
  /**
   * Optional raw header lines, e.g. ["Authorization: Bearer $MY_TOKEN", "X-Gateway-Key: $GW_KEY"].
   * Each entry is "Name: Value"; the value portion supports $ENV_VAR interpolation.
   * Lets gateways/proxies that need more than a single bearer token be configured.
   */
  headers?: string[];
}

/** Configuration for a single backend (one or more servers). */
export interface BackendConfig {
  urls: ServerEntry[];
}

/** A rule that annotates auto-discovered models matching a pattern. */
export interface Rule {
  /** Regex pattern or literal string, interpreted per `type`. */
  match: string;
  type: "regex" | "string";
  options: {
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
  };
}

/** Full shape of `~/.pi/agent/local-models.json`. */
export interface LocalModelsConfig {
  backends: {
    lmstudio?: BackendConfig;
    ollama?: BackendConfig;
    llamacpp?: BackendConfig;
    mlx?: BackendConfig;
  };
  rules?: Rule[];
}

/**
 * Backend-agnostic representation of a discovered model, before rule
 * application. Fields left `undefined` mean the backend couldn't expose
 * that metadata; `rules.ts` and/or Pi's own built-in defaults fill the gap.
 */
export interface NormalizedModel {
  /** Model identifier to send to the API. */
  id: string;
  /** Human label (falls back to `id` if the backend has no better name). */
  displayName: string;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  reasoning?: boolean | undefined;
  /** Maps to `input: ["text", "image"]` when true. */
  vision?: boolean | undefined;
}

/** Signature every backend discovery module must implement. */
export type DiscoverModels = (server: ServerEntry) => Promise<NormalizedModel[]>;

export type { ProviderModelConfig };
