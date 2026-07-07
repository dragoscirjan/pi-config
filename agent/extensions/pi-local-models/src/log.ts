const PREFIX = "[pi-local-models]";

type Notifier = (message: string, type?: "info" | "warning" | "error") => void;

/** Set by the extension whenever an `ExtensionContext` (with `ctx.ui`) is
 * available, so warnings surface as in-app notifications (e.g. after
 * `/reload`) instead of only going to a console nobody is watching.
 * Falls back to `console.error` when no UI context has been set yet
 * (e.g. during the initial top-level sync at extension load). */
let notifier: Notifier | undefined;

export function setNotifier(fn: Notifier | undefined): void {
  notifier = fn;
}

/** Suppresses all `logWarn` output for the duration of `fn`. Used to mute
 * the very first (pre-`ctx`) sync at extension load in interactive mode,
 * since the `session_start` handler runs an equivalent sync moments later
 * with a real notifier attached — logging both would just be a duplicate. */
let suppressed = false;

export async function runSilently<T>(fn: () => Promise<T>): Promise<T> {
  const previous = suppressed;
  suppressed = true;
  try {
    return await fn();
  } finally {
    suppressed = previous;
  }
}

/**
 * Turns an unknown thrown value into a short, human-readable one-liner.
 * Strips stack traces and undici/Node internals — just the useful bit
 * (e.g. "connection refused", "timed out", "host not found").
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code: unknown }).code) : undefined;

    if (error.name === "AbortError" || code === "ABORT_ERR") return "timed out";
    if (code === "ECONNREFUSED") return "connection refused (is the server running?)";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host not found";
    if (code === "ETIMEDOUT") return "timed out";
    if (error.message === "fetch failed" && cause instanceof Error) return cause.message;
    return error.message;
  }
  return String(error);
}

/** Logs a concise one-line warning: "[pi-local-models] <context>: <reason>".
 * Uses `ctx.ui.notify` when available (see `setNotifier`), otherwise falls
 * back to `console.error`. */
export function logWarn(context: string, error?: unknown): void {
  if (suppressed) return;

  const message = error === undefined ? `${PREFIX} ${context}` : `${PREFIX} ${context}: ${describeError(error)}`;

  if (notifier) {
    notifier(message, "warning");
  } else {
    console.error(message);
  }
}
