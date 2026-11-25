import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PACKAGE_NAME, WORKSPACE } from './release-check.mjs';
import releaseConfig from './release-config.mjs';
import { recoverTaggedRelease } from './release-recover.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-release-retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'checkout');
  const remote = join(dir, 'remote.git');
  mkdirSync(repo);
  const env = {
    ...process.env,
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_EVENT_PATH: '',
    GITHUB_WORKSPACE: repo,
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
    NPM_TOKEN: '',
    npm_config_offline: 'true',
    GIT_TERMINAL_PROMPT: '0',
  };
  env.NODE_TEST_CONTEXT = '';
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  const manifest = join(workspace, 'package.json');
  writeFileSync(manifest, JSON.stringify({ name: PACKAGE_NAME, version: '0.0.0' }));
  writeFileSync(join(workspace, 'index.js'), 'export const voice = true;\n');
  git('add', '.');
  git('commit', '-m', 'feat: initial voice package');
  git('push', '--set-upstream', 'origin', 'main');
  const gitTag = `${PACKAGE_NAME}@1.0.0`;
  const tag = () => {
    git('tag', gitTag);
    git('push', 'origin', gitTag);
  };
  const options = { ...releaseConfig, repositoryUrl: pathToFileURL(remote).href };
  const context = { cwd: repo, env, options, logger: { log() {} } };
  const state = { npm: false, github: false, npmAttempts: 0, githubAttempts: 0, events: [] };
  const dependencies = {
    async request(url) {
      const isNpm = url.startsWith('https://registry.npmjs.org/');
      const exists = isNpm ? state.npm : state.github;
      return new Response(
        exists
          ? JSON.stringify(
              isNpm
                ? { name: PACKAGE_NAME, version: '1.0.0' }
                : { tag_name: gitTag, draft: false, body: 'Existing notes' },
            )
          : null,
        { status: exists ? 200 : 404 },
      );
    },
    async plugins() {
      state.events.push('plugins');
      return {
        npm: {
          async verifyConditions() {
            state.events.push('npm.verify');
          },
          async prepare(_config, ctx) {
            state.events.push('npm.prepare');
            const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
            pkg.version = ctx.nextRelease.version;
            writeFileSync(manifest, JSON.stringify(pkg));
          },
          async publish(_config, ctx) {
            state.events.push('npm.publish');
            state.npmAttempts++;
            if (state.failNpm) throw new Error('npm publication rejected');
            assert.equal(ctx.nextRelease.gitHead, git('rev-parse', 'HEAD'));
            assert.equal(ctx.nextRelease.version, '1.0.0');
            state.npm = true;
            return { name: 'npm fixture', url: 'https://example.invalid/npm' };
          },
        },
        github: {
          async verifyConditions() {
            state.events.push('github.verify');
          },
          async publish(_config, ctx) {
            state.events.push('github.publish');
            state.githubAttempts++;
            if (state.failGithub) throw new Error('GitHub publication rejected');
            assert.equal(ctx.nextRelease.gitTag, gitTag);
            state.github = true;
            return { name: 'GitHub fixture', url: 'https://example.invalid/github' };
          },
        },
        async generateNotes(_config, ctx) {
          assert.ok(ctx.commits.some(({ message }) => message === 'feat: initial voice package'));
          return 'Recovered release notes';
        },
      };
    },
    audit(cwd) {
      assert.equal(cwd, repo);
      assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).version, '1.0.0');
      state.events.push('audit');
    },
  };
  return { dir, repo, env, git, gitTag, tag, options, context, state, dependencies };
}

it('recovers a tagged-but-unpublished version without moving tags or bumping again', async (t) => {
  const f = fixture(t);
  f.tag();
  const before = f.git('ls-remote', '--tags', 'origin');
  const result = await recoverTaggedRelease(f.context, f.dependencies);
  assert.equal(result.recovered, true);
  assert.equal(result.nextRelease.version, '1.0.0');
  assert.deepEqual(f.state.events, [
    'plugins',
    'github.verify',
    'npm.verify',
    'npm.prepare',
    'audit',
    'npm.publish',
    'github.publish',
  ]);
  assert.equal(f.git('ls-remote', '--tags', 'origin'), before);
  f.state.events = [];
  assert.equal((await recoverTaggedRelease(f.context, f.dependencies)).recovered, false);
  assert.deepEqual(f.state.events, []);
  assert.equal(f.state.npmAttempts, 1);
  assert.equal(f.state.githubAttempts, 1);
});

it('does not republish npm when only the GitHub release needs recovery', async (t) => {
  const f = fixture(t);
  f.tag();
  f.state.npm = true;
  await recoverTaggedRelease(f.context, f.dependencies);
  assert.equal(f.state.npmAttempts, 0);
  assert.ok(!f.state.events.includes('npm.prepare'));
  assert.equal(f.state.githubAttempts, 1);
});

it('retries npm failure at the same tagged version, then treats published outputs as a no-op', async (t) => {
  const f = fixture(t);
  f.tag();
  f.state.failNpm = true;
  await assert.rejects(recoverTaggedRelease(f.context, f.dependencies), /npm publication rejected/u);
  assert.equal(f.state.githubAttempts, 0);
  f.state.failNpm = false;
  await recoverTaggedRelease(f.context, f.dependencies);
  assert.equal(f.state.npmAttempts, 2);
  assert.equal((await recoverTaggedRelease(f.context, f.dependencies)).recovered, false);
  assert.equal(f.state.npmAttempts, 2);
});

it('retries GitHub failure without duplicating a successful npm publication', async (t) => {
  const f = fixture(t);
  f.tag();
  f.state.failGithub = true;
  await assert.rejects(recoverTaggedRelease(f.context, f.dependencies), /GitHub publication rejected/u);
  assert.equal(f.state.npm, true);
  f.state.failGithub = false;
  await recoverTaggedRelease(f.context, f.dependencies);
  assert.equal(f.state.npmAttempts, 1);
  assert.equal(f.state.githubAttempts, 2);
});

it('fails closed on registry errors and refuses malformed metadata instead of reporting a no-op', async (t) => {
  const f = fixture(t);
  f.tag();
  for (const request of [
    async () => new Response(null, { status: 503 }),
    async () => {
      throw new Error('network unavailable');
    },
    async () => new Response(JSON.stringify({ name: 'wrong-package', version: '1.0.0' })),
    async () => new Response('null'),
  ]) {
    await assert.rejects(recoverTaggedRelease(f.context, { ...f.dependencies, request }));
    assert.deepEqual(f.state.events, []);
  }
});

it('does not publish if the prepared recovery package fails the artifact audit', async (t) => {
  const f = fixture(t);
  f.tag();
  await assert.rejects(
    recoverTaggedRelease(f.context, {
      ...f.dependencies,
      audit() {
        throw new Error('Forbidden file');
      },
    }),
    /Forbidden file/u,
  );
  assert.equal(f.state.npmAttempts, 0);
  assert.equal(f.state.githubAttempts, 0);
});

it('leaves new and superseded commits to the normal release flow without registry access', async (t) => {
  const f = fixture(t);
  const dependencies = {
    request() {
      assert.fail('Must not access a registry');
    },
  };
  assert.equal(await recoverTaggedRelease(f.context, dependencies), null);
  f.tag();
  f.git('commit', '--allow-empty', '-m', 'fix: newer push');
  f.git('push', 'origin', 'main');
  f.git('checkout', '--detach', 'HEAD~1');
  assert.equal(await recoverTaggedRelease(f.context, dependencies), null);
});

it('recovers a real semantic-release publish failure AFTER its remote tag push', async (t) => {
  const f = fixture(t);
  const failurePlugin = join(f.dir, 'fail-publish.mjs');
  writeFileSync(
    failurePlugin,
    "export function publish() { throw new Error('simulated npm failure after tag push'); }\n",
  );
  const options = {
    ...f.options,
    plugins: [
      [fileURLToPath(import.meta.resolve('@semantic-release/commit-analyzer')), releaseConfig.plugins[0][1]],
      [fileURLToPath(import.meta.resolve('@semantic-release/npm')), { pkgRoot: WORKSPACE, npmPublish: false }],
      failurePlugin,
    ],
  };
  const script = `
    import semanticRelease from ${JSON.stringify(import.meta.resolve('semantic-release'))};
    await semanticRelease(JSON.parse(process.argv[1]), { cwd: process.argv[2] });
  `;
  f.git('checkout', '--detach', 'HEAD');
  assert.throws(
    () =>
      execFileSync(process.execPath, ['--input-type=module', '--eval', script, JSON.stringify(options), f.repo], {
        cwd: f.repo,
        env: { ...f.env, GITHUB_SHA: f.git('rev-parse', 'HEAD') },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      }),
    /simulated npm failure after tag push/u,
  );
  const tagBefore = f.git('ls-remote', '--tags', 'origin');
  assert.ok(tagBefore.includes(f.gitTag), 'semantic-release must have pushed its tag before the failure');
  f.git('checkout', '--', `${WORKSPACE}/package.json`);
  const dependencies = {
    ...f.dependencies,
    async plugins() {
      const fake = await f.dependencies.plugins();
      const npm = await import('@semantic-release/npm');
      const { generateNotes } = await import('@semantic-release/release-notes-generator');
      return {
        ...fake,
        generateNotes: (config, context) =>
          generateNotes(config, {
            ...context,
            options: { ...context.options, repositoryUrl: releaseConfig.repositoryUrl },
          }),
        npm: {
          ...fake.npm,
          verifyConditions: (config, context) => npm.verifyConditions({ ...config, npmPublish: false }, context),
          prepare: (config, context) => npm.prepare({ ...config, npmPublish: false }, context),
        },
      };
    },
  };
  assert.equal((await recoverTaggedRelease(f.context, dependencies)).nextRelease.version, '1.0.0');
  assert.equal(f.state.npm, true);
  assert.equal(f.state.github, true);
  assert.equal(f.git('ls-remote', '--tags', 'origin'), tagBefore);
  assert.equal((await recoverTaggedRelease(f.context, f.dependencies)).recovered, false);
  assert.equal(f.state.npmAttempts, 1);
});
