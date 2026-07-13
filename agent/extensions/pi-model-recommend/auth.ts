import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@mariozechner/pi-coding-agent';

export function getAuthenticatedProvidersFromAuthJson(): Set<string> {
  const authPath = join(getAgentDir(), 'auth.json');
  if (!existsSync(authPath)) return new Set();

  try {
    const raw = readFileSync(authPath, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const providers = new Set<string>();

    for (const [provider, cfg] of Object.entries(json)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const typed = cfg as Record<string, unknown>;
      const type = String(typed.type ?? '').toLowerCase();
      const hasApiKey = Boolean(typed.key ?? typed.apiKey);
      const hasOAuthToken = Boolean(typed.access ?? typed.refresh ?? typed.token);

      if ((type === 'api_key' && hasApiKey) || (type === 'oauth' && hasOAuthToken) || hasApiKey || hasOAuthToken) {
        providers.add(provider);
      }
    }

    return providers;
  } catch {
    return new Set();
  }
}
