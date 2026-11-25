import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease, REPOSITORY, ROOT } from './release-check.mjs';
import releaseConfig from './release-config.mjs';
import { recoverTaggedRelease } from './release-recover.mjs';

export function assertPublishEnvironment(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Publishing is CI-only. See RELEASING.md.');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, 'Publishing from this repository is not allowed.');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Only main may publish.');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_run', 'Publishing requires a completed CI run.');
  assert.equal(env.RELEASE_EVENT, 'push', 'Only push-triggered CI may publish.');
  assert.equal(env.RELEASE_BRANCH, 'main', 'Only tested main commits may publish.');
  assert.equal(env.RELEASE_REPOSITORY, REPOSITORY, 'Fork CI must never publish.');
  assert.equal(env.RELEASE_CONCLUSION, 'success', 'The complete CI matrix must pass before publishing.');
  assert.match(env.RELEASE_SHA ?? '', /^[a-f\d]{40}$/u, 'A tested commit SHA is required.');
  assert.ok(
    env.NPM_TOKEN || (env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN),
    'Configure npm trusted publishing or provide the one-time NPM_TOKEN bootstrap secret. See RELEASING.md.',
  );
}

export function assertTestedCommit(env, head) {
  assert.equal(head.trim(), env.RELEASE_SHA, 'Refusing to publish a commit different from the successful CI run.');
}

export async function publishRelease(env = process.env) {
  // Fail before loading plugins or accessing npm/GitHub when invoked on a workstation.
  assertPublishEnvironment(env);
  assertTestedCommit(env, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }));
  checkRelease();
  const recovered = await recoverTaggedRelease({ cwd: ROOT, env });
  if (recovered) return recovered;
  const { default: semanticRelease } = await import('semantic-release');
  return semanticRelease(releaseConfig, { cwd: ROOT, env });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await publishRelease();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
