import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import semver from 'semver';
import { checkRelease, PACKAGE_NAME, REPOSITORY } from './release-check.mjs';
import releaseConfig from './release-config.mjs';

function releaseTags(output) {
  return output
    .split('\n')
    .filter((tag) => tag.startsWith(`${PACKAGE_NAME}@`))
    .map((gitTag) => ({ gitTag, version: gitTag.slice(PACKAGE_NAME.length + 1) }))
    .filter(({ version }) => semver.valid(version) === version && !semver.prerelease(version))
    .sort((a, b) => semver.rcompare(a.version, b.version));
}

async function readOutput(url, label, env, request) {
  const headers = { Accept: 'application/json' };
  if (label === 'GitHub release' && (env.GITHUB_TOKEN || env.GH_TOKEN)) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN || env.GH_TOKEN}`;
  }
  const response = await request(url, { headers, signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  assert.equal(response.status, 200, `Cannot reconcile ${label}: HTTP ${response.status}. Refusing a false no-op.`);
  const output = await response.json();
  assert.ok(output && typeof output === 'object' && !Array.isArray(output), `Invalid ${label} metadata.`);
  return output;
}

async function loadPlugins() {
  const [npm, github, notes] = await Promise.all([
    import('@semantic-release/npm'),
    import('@semantic-release/github'),
    import('@semantic-release/release-notes-generator'),
  ]);
  return { npm, github, generateNotes: notes.generateNotes };
}

// semantic-release pushes its tag BEFORE publish. Replay missing outputs at that exact
// tested commit instead of deleting an immutable tag or silently accepting a no-op.
export async function recoverTaggedRelease(
  { cwd, env, options = releaseConfig, logger = console },
  { request = fetch, plugins = loadPlugins, audit = checkRelease } = {},
) {
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const tagged = releaseTags(git('tag', '--points-at', 'HEAD'))[0];
  if (!tagged) return null;
  const head = git('rev-parse', 'HEAD');
  const remoteHead = git('ls-remote', '--exit-code', options.repositoryUrl, 'refs/heads/main').split(/\s/u)[0];
  if (remoteHead !== head) return null; // Let semantic-release skip a superseded CI run normally.

  const { version, gitTag } = tagged;
  const [npmOutput, githubOutput] = await Promise.all([
    readOutput(
      `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/${version}`,
      'npm version',
      env,
      request,
    ),
    readOutput(
      `https://api.github.com/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(gitTag)}`,
      'GitHub release',
      env,
      request,
    ),
  ]);
  if (npmOutput) {
    assert.equal(npmOutput.name, PACKAGE_NAME, 'Unexpected npm package while reconciling release.');
    assert.equal(npmOutput.version, version, 'Unexpected npm version while reconciling release.');
  }
  if (githubOutput) {
    assert.equal(githubOutput.tag_name, gitTag, 'Unexpected GitHub release tag.');
    assert.equal(githubOutput.draft, false, 'A draft GitHub release requires owner intervention.');
  }
  if (npmOutput && githubOutput) {
    logger.log(`Release ${gitTag} is already published to npm and GitHub; nothing to retry.`);
    return { nextRelease: tagged, releases: [], recovered: false };
  }

  logger.log(`Recovering incomplete tagged release ${gitTag} without changing its tag.`);
  const previous = releaseTags(git('tag', '--merged', 'HEAD')).find((tag) => semver.lt(tag.version, version));
  const rawCommits = git('log', '--format=%H%x00%B%x00', previous ? `${previous.gitTag}..HEAD` : 'HEAD').split('\0');
  const commits = [];
  for (let i = 0; i + 1 < rawCommits.length; i += 2) {
    commits.push({ hash: rawCommits[i].trim(), message: rawCommits[i + 1].trim() });
  }
  const context = {
    cwd,
    env,
    options,
    logger,
    stdout: process.stdout,
    stderr: process.stderr,
    branch: { name: 'main', type: 'release', main: true },
    lastRelease: previous ? { ...previous, gitHead: git('rev-parse', `${previous.gitTag}^{commit}`) } : {},
    nextRelease: { ...tagged, gitHead: head, channel: null },
    commits,
    releases: [],
  };
  const { npm, github, generateNotes } = await plugins();
  const pluginOptions = (name) => options.plugins.find((plugin) => plugin[0] === name)[1];
  const npmConfig = pluginOptions('@semantic-release/npm');
  const githubConfig = pluginOptions('@semantic-release/github');
  // Verify every required credential before creating any missing output.
  if (!githubOutput) await github.verifyConditions(githubConfig, context);
  if (!npmOutput) await npm.verifyConditions(npmConfig, context);
  context.nextRelease.notes =
    githubOutput?.body ?? (await generateNotes(pluginOptions('@semantic-release/release-notes-generator'), context));
  if (!npmOutput) {
    await npm.prepare(npmConfig, context);
    audit(cwd);
    const published = await npm.publish(npmConfig, context);
    if (published) context.releases.push({ ...published, pluginName: '@semantic-release/npm' });
  }
  if (!githubOutput) {
    const published = await github.publish(githubConfig, context);
    if (published) context.releases.push({ ...published, pluginName: '@semantic-release/github' });
  }
  return { nextRelease: context.nextRelease, releases: context.releases, recovered: true };
}
