import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease, REPOSITORY, ROOT, runNpm } from './release-check.mjs';

export function assertPublishEnvironment(env) {
  assert.equal(
    env.GITHUB_ACTIONS,
    'true',
    'Publishing is CI-only. See RELEASING.md for the one-time manual bootstrap.',
  );
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, 'Publishing from this repository is not allowed.');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Only main may publish.');
  assert.equal(env.NPM_PUBLISH_ENABLED, 'true', 'Publishing is disabled until NPM_PUBLISH_ENABLED is enabled.');
  assert.ok(
    env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'npm trusted publishing (OIDC) is required.',
  );
}

export function assertTrustedNpmVersion(version) {
  const match = /^(\d+)\.(\d+)\./u.exec(version.trim());
  assert.ok(
    match && Number(match[1]) === 11 && Number(match[2]) >= 21,
    'Use npm >=11.21 and <12 with Changesets CLI v2 for trusted publishing and dist-tags.',
  );
}

export function publishRelease(env = process.env) {
  // Fail before running any npm/registry commands when called accidentally on a workstation.
  assertPublishEnvironment(env);
  assertTrustedNpmVersion(runNpm(['--version']).trim());
  checkRelease();
  const require = createRequire(import.meta.url);
  const cli = require.resolve('@changesets/cli/bin.js');
  const result = spawnSync(process.execPath, [cli, 'publish'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...env, NPM_CONFIG_PROVENANCE: 'true' },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Changesets publishing failed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    publishRelease();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
