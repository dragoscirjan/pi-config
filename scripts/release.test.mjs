import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  npmInvocation,
  PACKAGE_NAME,
  REPOSITORY,
  singlePackResult,
  validateManifests,
  validatePacklist,
  validateRelativeImports,
  WORKSPACE,
} from './release-check.mjs';
import { assertPublishEnvironment, assertTestedCommit } from './release-publish.mjs';

function manifests() {
  return {
    root: { private: true },
    workspaces: {
      [WORKSPACE]: {
        name: PACKAGE_NAME,
        version: '1.0.0',
        license: 'MIT',
        publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
        repository: { url: `git+https://github.com/${REPOSITORY}.git`, directory: WORKSPACE },
        pi: { extensions: ['./index.ts'] },
        keywords: ['pi-package'],
        peerDependencies: {
          '@earendil-works/pi-coding-agent': '*',
          '@earendil-works/pi-tui': '*',
          '@juicesharp/rpiv-voice': '2.15.0',
          '@juicesharp/rpiv-i18n': '^2.15.0',
        },
      },
      'agent/extensions/pi-local-models': { private: true },
      'agent/extensions/pi-model-recommend': { private: true },
    },
  };
}
function pack(extra = []) {
  return {
    name: PACKAGE_NAME,
    version: '1.0.0',
    unpackedSize: 20000,
    files: ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'index.ts', 'src/backend.ts', ...extra].map(
      (path) => ({ path }),
    ),
  };
}
function ciEnvironment() {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_run',
    RELEASE_EVENT: 'push',
    RELEASE_BRANCH: 'main',
    RELEASE_REPOSITORY: REPOSITORY,
    RELEASE_CONCLUSION: 'success',
    RELEASE_SHA: 'a'.repeat(40),
    ACTIONS_ID_TOKEN_REQUEST_URL: 'test-url',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
  };
}

describe('publication boundary', () => {
  it('permits only the scoped voice companion', () => {
    const f = manifests();
    assert.equal(validateManifests(f.root, f.workspaces).name, PACKAGE_NAME);
  });
  it('refuses publishing the config root or another workspace', () => {
    const f = manifests();
    assert.throws(() => validateManifests({ private: false }, f.workspaces), /root must stay private/u);
    f.workspaces['agent/extensions/pi-local-models'].private = false;
    assert.throws(() => validateManifests(f.root, f.workspaces), /not approved/u);
  });
  it('checks npm scope and provenance repository', () => {
    const f = manifests();
    f.workspaces[WORKSPACE].name = 'pi-voice-ptt';
    assert.throws(() => validateManifests(f.root, f.workspaces), /package\/scope/u);
    f.workspaces[WORKSPACE].name = PACKAGE_NAME;
    f.workspaces[WORKSPACE].repository.url = 'git+https://github.com/wrong/repo.git';
    assert.throws(() => validateManifests(f.root, f.workspaces), /provenance/u);
  });
  it('rejects install hooks and separate bundled host instances', () => {
    const f = manifests();
    f.workspaces[WORKSPACE].scripts = { postinstall: 'unexpected command' };
    assert.throws(() => validateManifests(f.root, f.workspaces), /install-time hook/u);
    delete f.workspaces[WORKSPACE].scripts;
    f.workspaces[WORKSPACE].dependencies = { '@earendil-works/pi-tui': '*' };
    assert.throws(() => validateManifests(f.root, f.workspaces), /separate integration instance/u);
  });
});

describe('npm artifact allowlist', () => {
  const pkg = { name: PACKAGE_NAME, version: '1.0.0' };
  it('normalizes npm 11 and npm 12 pack JSON without accepting extra packages', () => {
    const value = pack();
    assert.equal(singlePackResult([value]), value);
    assert.equal(singlePackResult({ [PACKAGE_NAME]: value }), value);
    for (const invalid of [null, {}, [value, value], { [PACKAGE_NAME]: value, other: value }, { other: value }]) {
      assert.throws(() => singlePackResult(invalid), /Only the approved workspace/u);
    }
  });
  it('accepts runtime source, documentation and license only', () => {
    assert.ok(validatePacklist(pkg, pack()).has('src/backend.ts'));
  });
  for (const path of [
    'agent/mcp.json',
    '.npmrc',
    '.env',
    'models/model.onnx',
    'node_modules/x/index.js',
    'src/a.test.ts',
    'src/a.spec.ts',
    'src/__tests__/a.ts',
    'src/../private.ts',
  ]) {
    it(`rejects ${path}`, () => assert.throws(() => validatePacklist(pkg, pack([path])), /Forbidden/u));
  }
  it('rejects model-sized artifacts and missing entrypoints', () => {
    assert.throws(() => validatePacklist(pkg, { ...pack(), unpackedSize: 200000000 }), /size/u);
    const missing = pack();
    missing.files = missing.files.filter((file) => file.path !== 'index.ts');
    assert.throws(() => validatePacklist(pkg, missing), /Missing packed file/u);
  });
  it('checks that .js imports resolve to shipped TypeScript sources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-release-test-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'index.ts'), "import { value } from './src/value.js';\n");
      writeFileSync(join(dir, 'src/value.ts'), 'export const value = 1;\n');
      validateRelativeImports(dir, new Set(['index.ts', 'src/value.ts']));
      assert.throws(() => validateRelativeImports(dir, new Set(['index.ts'])), /unpackaged file/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cross-platform tooling', () => {
  it('keeps commit hooks read-only so personal or partially staged changes are not swept in', () => {
    const hook = readFileSync(new URL('../.husky/pre-commit', import.meta.url), 'utf8');
    assert.doesNotMatch(hook, /\bgit\s+add\b/u);
    assert.doesNotMatch(hook, /\b(?:format|lint):fix\b/u);
    assert.match(hook, /for cmd in format lint;/u);
  });
  it('pins text checkout to LF independently of Windows Git defaults', () => {
    const policy = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
    assert.match(policy, /^\* text=auto eol=lf$/mu);
  });
  it('uses a Windows npm shim only with its required shell', () => {
    assert.deepEqual(npmInvocation(['pack'], {}, 'win32'), { command: 'npm.cmd', args: ['pack'], shell: true });
    assert.deepEqual(npmInvocation(['pack'], {}, 'linux'), { command: 'npm', args: ['pack'], shell: false });
  });
});

describe('publishing cannot run accidentally', () => {
  it('refuses a developer workstation before executing npm', () => {
    assert.throws(() => assertPublishEnvironment({}), /CI-only/u);
  });
  for (const [key, value] of [
    ['GITHUB_REPOSITORY', 'someone/fork'],
    ['GITHUB_REF', 'refs/heads/feature'],
    ['GITHUB_EVENT_NAME', 'push'],
    ['RELEASE_EVENT', 'pull_request'],
    ['RELEASE_EVENT', 'workflow_dispatch'],
    ['RELEASE_BRANCH', 'feature'],
    ['RELEASE_REPOSITORY', 'someone/fork'],
    ['RELEASE_CONCLUSION', 'failure'],
    ['RELEASE_CONCLUSION', 'cancelled'],
    ['RELEASE_CONCLUSION', 'skipped'],
    ['RELEASE_SHA', 'main'],
    ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', ''],
    ['ACTIONS_ID_TOKEN_REQUEST_URL', ''],
  ]) {
    it(`rejects unsafe ${key}`, () => {
      assert.throws(() => assertPublishEnvironment({ ...ciEnvironment(), [key]: value }));
    });
  }
  it('accepts trusted publishing without an opt-in variable', () => {
    assertPublishEnvironment(ciEnvironment());
  });
  it('allows a one-time token bootstrap in the same successful CI context', () => {
    const env = ciEnvironment();
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    assert.throws(() => assertPublishEnvironment(env), /NPM_TOKEN bootstrap/u);
    env.NPM_TOKEN = 'test-bootstrap-token';
    assertPublishEnvironment(env);
    assert.throws(() => assertPublishEnvironment({ ...env, RELEASE_CONCLUSION: 'failure' }));
  });
  it('requires the exact commit tested by CI', () => {
    const env = ciEnvironment();
    assertTestedCommit(env, `${env.RELEASE_SHA}\n`);
    assert.throws(() => assertTestedCommit(env, 'b'.repeat(40)), /different from the successful CI run/u);
  });
});
