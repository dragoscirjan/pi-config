import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@dragoscirjan/pi-voice-ptt';
export const WORKSPACE = 'agent/extensions/pi-voice-ptt';
export const REPOSITORY = 'dragoscirjan/pi-config';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org/';
const REQUIRED_FILES = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'index.ts'];

export function validateManifests(rootPackage, workspaces) {
  assert.equal(rootPackage.private, true, 'The personal config root must stay private.');
  assert.ok(workspaces[WORKSPACE], 'The release workspace is missing.');
  for (const [directory, pkg] of Object.entries(workspaces)) {
    if (directory !== WORKSPACE) assert.equal(pkg.private, true, `${directory} is not approved for publication.`);
  }
  const pkg = workspaces[WORKSPACE];
  assert.equal(pkg.name, PACKAGE_NAME, 'Unexpected release package/scope.');
  assert.notEqual(pkg.private, true, 'The release package is still private.');
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/iu, 'Invalid release version.');
  assert.equal(pkg.license, 'MIT', 'The approved release license is MIT.');
  assert.equal(pkg.publishConfig?.access, 'public', 'Scoped releases must explicitly be public.');
  assert.equal(pkg.publishConfig?.registry, REGISTRY, 'Unexpected publish registry.');
  assert.equal(
    pkg.repository?.url,
    `git+https://github.com/${REPOSITORY}.git`,
    'Repository must match npm provenance.',
  );
  assert.equal(pkg.repository?.directory, WORKSPACE, 'Missing monorepo source directory.');
  assert.deepEqual(pkg.pi?.extensions, ['./index.ts'], 'Unexpected Pi extension entrypoints.');
  assert.ok(pkg.keywords?.includes('pi-package'), 'Missing Pi package discovery keyword.');
  for (const peer of [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    '@juicesharp/rpiv-voice',
    '@juicesharp/rpiv-i18n',
  ]) {
    assert.ok(pkg.peerDependencies?.[peer], `Missing declared integration peer: ${peer}`);
    assert.ok(!pkg.dependencies?.[peer], `Do not bundle/install a separate integration instance: ${peer}`);
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.ok(!pkg.scripts?.[hook], `Unexpected install-time hook: ${hook}`);
  }
  return pkg;
}

export function singlePackResult(value) {
  // npm <=11 returns an array; npm 12 keys the result by workspace name.
  const packages = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, PACKAGE_NAME)
      ? [value[PACKAGE_NAME]]
      : [];
  assert.equal(packages.length, 1, 'Only the approved workspace may be packed.');
  return packages[0];
}

export function validatePacklist(pkg, pack) {
  assert.equal(pack.name, pkg.name, 'Packed the wrong package.');
  assert.equal(pack.version, pkg.version, 'Packed the wrong version.');
  assert.ok(
    pack.unpackedSize > 0 && pack.unpackedSize <= 1_000_000,
    'Unexpected package size; models/builds must not be bundled.',
  );
  const names = new Set();
  for (const file of pack.files ?? []) {
    const name = file.path;
    const parts = name.split('/');
    const runtimeSource =
      name.startsWith('src/') &&
      name.endsWith('.ts') &&
      !/\.(test|spec)\.ts$/u.test(name) &&
      !parts.some((part) => part.startsWith('.') || part.startsWith('__'));
    assert.ok(REQUIRED_FILES.includes(name) || runtimeSource, `Forbidden packed file: ${name}`);
    assert.ok(!names.has(name), `Duplicate packed file: ${name}`);
    names.add(name);
  }
  for (const required of REQUIRED_FILES) assert.ok(names.has(required), `Missing packed file: ${required}`);
  return names;
}

export function validateRelativeImports(directory, names) {
  for (const name of names) {
    if (!name.endsWith('.ts')) continue;
    const source = readFileSync(resolve(directory, name), 'utf8');
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/gu);
    for (const match of imports) {
      let target = posix.normalize(posix.join(posix.dirname(name), match[1]));
      if (target.endsWith('.js')) target = target.slice(0, -3) + '.ts';
      assert.ok(names.has(target), `${name} imports an unpackaged file: ${target}`);
    }
  }
}

/** npm.cmd needs a shell on Windows; npm-run supplies npm-cli.js for a direct, shell-free path. */
export function npmInvocation(args, env = process.env, platform = process.platform) {
  if (env.npm_execpath?.endsWith('npm-cli.js') && existsSync(env.npm_execpath)) {
    return { command: process.execPath, args: [env.npm_execpath, ...args], shell: false };
  }
  return { command: platform === 'win32' ? 'npm.cmd' : 'npm', args, shell: platform === 'win32' };
}

export function runNpm(args, root = ROOT) {
  const call = npmInvocation(args);
  const result = spawnSync(call.command, call.args, { cwd: root, encoding: 'utf8', shell: call.shell });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `npm ${args[0]} failed.`);
  return result.stdout;
}

export function checkRelease(root = ROOT) {
  const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(rootPackage.workspaces), 'Release policy requires explicit workspace directories.');
  const workspaces = Object.fromEntries(
    rootPackage.workspaces.map((directory) => {
      assert.ok(
        !directory.includes('*') && !directory.includes('..'),
        'Use explicit in-repository workspace directories.',
      );
      return [directory, JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8'))];
    }),
  );
  const pkg = validateManifests(rootPackage, workspaces);
  const pack = singlePackResult(
    JSON.parse(runNpm(['pack', '--dry-run', '--json', '--ignore-scripts', '--workspace', PACKAGE_NAME], root)),
  );
  const names = validatePacklist(pkg, pack);
  validateRelativeImports(resolve(root, WORKSPACE), names);
  console.log(
    `Release check: ${pkg.name}@${pkg.version}, ${names.size} files, ${pack.unpackedSize} bytes. Dry run only; nothing published.`,
  );
  return { pkg, pack };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkRelease();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
