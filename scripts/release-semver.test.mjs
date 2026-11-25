import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { parse } from 'yaml';
import { PACKAGE_NAME, ROOT, WORKSPACE } from './release-check.mjs';
import releaseConfig, { commitRules } from './release-config.mjs';

const logger = { log() {} };
const readWorkflow = (name) =>
  parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

describe('automatic semantic versions', () => {
  for (const [message, expected] of [
    ['fix: correct microphone selection', 'patch'],
    ['feat: select a local voice model', 'minor'],
    ['feat!: change the voice activation API', 'major'],
    ['fix: change preferences\n\nBREAKING CHANGE: old preferences must be migrated', 'major'],
    ['docs: clarify installation', 'patch'],
    ['chore: refresh dependencies', 'patch'],
    ['Merge pull request #20 from owner/branch', 'patch'],
  ]) {
    it(`${message.split('\n')[0]} -> ${expected}`, async () => {
      assert.equal(await analyzeCommits(commitRules, { cwd: ROOT, commits: [{ message }], logger }), expected);
    });
  }
  it('takes the highest bump in a push and does not republish an unchanged commit', async () => {
    const context = { cwd: ROOT, logger };
    assert.equal(
      await analyzeCommits(commitRules, {
        ...context,
        commits: [{ message: 'fix: one' }, { message: 'feat: two' }, { message: 'docs: three' }],
      }),
      'minor',
    );
    assert.equal(await analyzeCommits(commitRules, { ...context, commits: [] }), null);
  });
});

describe('release workflow boundary', () => {
  it('waits for the complete existing cross-platform CI workflow', () => {
    const ci = readWorkflow('ci');
    assert.deepEqual(ci.on.push.branches, ['main']);
    assert.deepEqual(ci.jobs.check.strategy.matrix.os, ['ubuntu-latest', 'macos-latest', 'windows-latest']);
    assert.ok(ci.jobs.check.steps.some((step) => step.run === 'npm run release:verify'));
    const release = readWorkflow('release');
    assert.deepEqual(release.on, { workflow_run: { workflows: [ci.name], types: ['completed'], branches: ['main'] } });
    for (const guard of [
      "github.repository == 'dragoscirjan/pi-config'",
      'github.event.workflow_run.head_repository.full_name == github.repository',
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.conclusion == 'success'",
    ]) {
      assert.ok(release.jobs.release.if.includes(guard), `Missing release guard: ${guard}`);
    }
    assert.equal(release.concurrency['cancel-in-progress'], false);
    assert.deepEqual(release.jobs.release.permissions, { contents: 'write', 'id-token': 'write' });
    const checkout = release.jobs.release.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ github.event.workflow_run.head_sha }}');
    assert.equal(checkout.with['fetch-depth'], 0);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(release.jobs.release.env.RELEASE_SHA, checkout.with.ref);
    assert.ok(release.jobs.release.steps.some((step) => step.run === 'npm run release:publish'));
    assert.ok(!JSON.stringify(release).includes('NPM_PUBLISH_ENABLED'));
    assert.ok(!JSON.stringify(release).includes('changesets/action'));
  });
  it('only publishes the approved workspace and audits the generated version before publishing', () => {
    assert.deepEqual(releaseConfig.branches, ['main']);
    assert.equal(releaseConfig.tagFormat, `${PACKAGE_NAME}@\${version}`);
    const npmIndex = releaseConfig.plugins.findIndex((plugin) => plugin[0] === '@semantic-release/npm');
    assert.deepEqual(releaseConfig.plugins[npmIndex][1], { pkgRoot: WORKSPACE, npmPublish: true });
    assert.equal(releaseConfig.plugins[npmIndex + 1], './scripts/release-audit.mjs');
    assert.ok(!releaseConfig.plugins.some((plugin) => plugin[0] === '@semantic-release/git'));
  });
});

it('creates real local releases and skips unchanged or superseded commits without registry publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-semantic-release-'));
  const remote = join(dir, 'remote.git');
  const repo = join(dir, 'checkout');
  const resultPath = join(dir, 'result.json');
  // semantic-release hooks process stdio, which would corrupt node:test's binary IPC.
  const childScript = `
    import semanticRelease from ${JSON.stringify(import.meta.resolve('semantic-release'))};
    import { writeFileSync } from 'node:fs';
    const result = await semanticRelease(JSON.parse(process.argv[1]), { cwd: process.argv[2] });
    writeFileSync(process.argv[3], JSON.stringify(result));
  `;
  const runRelease = (options) => {
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', childScript, JSON.stringify(options), repo, resultPath],
      {
        cwd: repo,
        env: { ...env, GITHUB_SHA: git('rev-parse', 'HEAD') },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      },
    );
    return JSON.parse(readFileSync(resultPath, 'utf8'));
  };
  const env = {
    ...process.env,
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_EVENT_PATH: '',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKSPACE: repo,
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
    NPM_TOKEN: '',
    npm_config_offline: 'true',
    GIT_TERMINAL_PROMPT: '0',
  };
  // npm's child Node processes must not inherit the parent's test-runner IPC protocol.
  delete env.NODE_TEST_CONTEXT;
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(repo);
    git('init', '--bare', '--initial-branch=main', remote);
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'release-test@example.invalid');
    git('config', 'user.name', 'Release Test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    git('config', 'core.hooksPath', join(dir, 'no-hooks'));
    git('remote', 'add', 'origin', pathToFileURL(remote).href);
    const workspace = join(repo, WORKSPACE);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\npackage-lock.json\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, workspaces: [WORKSPACE] }));
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version: '1.0.0' }));
    writeFileSync(join(workspace, 'index.js'), 'export const voice = true;\n');
    const options = {
      ...releaseConfig,
      ci: false,
      repositoryUrl: pathToFileURL(remote).href,
      plugins: [
        [fileURLToPath(import.meta.resolve('@semantic-release/commit-analyzer')), commitRules],
        [fileURLToPath(import.meta.resolve('@semantic-release/npm')), { pkgRoot: WORKSPACE, npmPublish: false }],
      ],
    };
    for (const [index, [message, expected]] of [
      ['feat: initial voice package', '1.0.0'],
      ['docs: clarify setup', '1.0.1'],
      ['feat: add device selection', '1.1.0'],
      ['feat!: change activation API', '2.0.0'],
    ].entries()) {
      writeFileSync(join(workspace, 'index.js'), `export const voice = ${index};\n`);
      git('add', '.');
      git('commit', '-m', message);
      git('push', '--set-upstream', 'origin', 'main');
      git('checkout', '--detach', 'HEAD');
      const result = runRelease(options);
      assert.equal(result.nextRelease.version, expected);
      assert.equal(JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).version, expected);
      assert.equal(git('rev-parse', `${PACKAGE_NAME}@${expected}`), git('rev-parse', 'HEAD'));
      // The working version is generated in CI, never committed back to main.
      git('checkout', '--', `${WORKSPACE}/package.json`);
      git('checkout', 'main');
    }
    assert.equal(runRelease(options), false);
    assert.equal(git('status', '--porcelain'), '');
    writeFileSync(join(workspace, 'index.js'), 'export const voice = 4;\n');
    git('add', '.');
    git('commit', '-m', 'fix: tested push superseded before release');
    git('push', 'origin', 'main');
    writeFileSync(join(workspace, 'index.js'), 'export const voice = 5;\n');
    git('add', '.');
    git('commit', '-m', 'fix: newer push still awaiting CI');
    git('push', 'origin', 'main');
    git('reset', '--hard', 'HEAD~1');
    assert.equal(runRelease(options), false, 'A superseded tested commit must not release');
    assert.equal(git('tag', '--list').split('\n').length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
