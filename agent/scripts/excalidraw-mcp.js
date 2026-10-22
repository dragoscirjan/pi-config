#!/usr/bin/env node

'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPOSITORY = 'https://github.com/excalidraw/excalidraw-mcp.git';
const INSTALL_DIR = path.join(os.homedir(), '.local', 'opt', 'excalidraw-mcp');
const ENTRYPOINT = path.join(INSTALL_DIR, 'dist', 'index.js');
const BUILD_STAMP = path.join(INSTALL_DIR, '.pi-mcp-build.json');
const INSTALL_LOCK = path.join(path.dirname(INSTALL_DIR), '.excalidraw-mcp.install.lock');
const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const STALE_LOCK_MS = 30 * 60 * 1000;

function log(message) {
  console.error(`[excalidraw-mcp] ${message}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function commandForPlatform(command, args, platform = process.platform) {
  if (platform === 'win32' && command === 'npx') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', [command, ...args].join(' ')],
    };
  }

  return { command, args };
}

function run(command, args, { cwd } = {}) {
  const resolved = commandForPlatform(command, args);

  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // stdout is reserved for the MCP protocol, including during bootstrap.
    child.stdout.pipe(process.stderr);
    child.stderr.pipe(process.stderr);

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with ${signal ?? `code ${code}`}`));
    });
  });
}

async function acquireInstallLock() {
  const startedAt = Date.now();
  fs.mkdirSync(path.dirname(INSTALL_LOCK), { recursive: true });

  while (true) {
    try {
      const descriptor = fs.openSync(INSTALL_LOCK, 'wx');
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      return () => {
        fs.closeSync(descriptor);
        fs.rmSync(INSTALL_LOCK, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      try {
        const age = Date.now() - fs.statSync(INSTALL_LOCK).mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.rmSync(INSTALL_LOCK, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }

      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for install lock ${INSTALL_LOCK}`);
      }

      await sleep(250);
    }
  }
}

async function ensureCheckout() {
  if (fs.existsSync(INSTALL_DIR)) {
    if (!fs.existsSync(path.join(INSTALL_DIR, '.git'))) {
      throw new Error(`${INSTALL_DIR} exists but is not an excalidraw-mcp Git checkout`);
    }
    return;
  }

  fs.mkdirSync(path.dirname(INSTALL_DIR), { recursive: true });
  log(`Cloning ${REPOSITORY} into ${INSTALL_DIR}`);
  await run('git', ['clone', '--depth', '1', REPOSITORY, INSTALL_DIR]);
}

function packageManager() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8'));
  const value = packageJson.packageManager ?? 'pnpm@10.11.0';

  if (!/^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`unsupported package manager: ${value}`);
  }

  return value;
}

function gitCommit() {
  const result = spawnSync('git', ['-C', INSTALL_DIR, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) throw new Error('could not determine the excalidraw-mcp Git revision');
  return result.stdout.trim();
}

function expectedBuildStamp(manager) {
  return {
    commit: gitCommit(),
    nodeMajor: Number(process.versions.node.split('.')[0]),
    packageManager: manager,
  };
}

function buildIsCurrent(expected) {
  if (!fs.existsSync(ENTRYPOINT) || !fs.existsSync(BUILD_STAMP)) return false;

  try {
    const actual = JSON.parse(fs.readFileSync(BUILD_STAMP, 'utf8'));
    return Object.keys(expected).every((key) => actual[key] === expected[key]);
  } catch {
    return false;
  }
}

async function ensureBuild() {
  const manager = packageManager();
  const stamp = expectedBuildStamp(manager);
  if (buildIsCurrent(stamp)) return;

  log(`Installing dependencies with ${manager}`);
  await run('npx', ['-y', manager, 'install', '--frozen-lockfile'], { cwd: INSTALL_DIR });

  log('Building server');
  await run('npx', ['-y', manager, 'run', 'build'], { cwd: INSTALL_DIR });

  if (!fs.existsSync(ENTRYPOINT)) {
    throw new Error(`build completed without creating ${ENTRYPOINT}`);
  }

  fs.writeFileSync(BUILD_STAMP, `${JSON.stringify(stamp, null, 2)}\n`);
}

async function bootstrap() {
  const releaseLock = await acquireInstallLock();
  try {
    await ensureCheckout();
    await ensureBuild();
  } finally {
    releaseLock();
  }
}

function launch() {
  const child = spawn(process.execPath, [ENTRYPOINT, '--stdio'], {
    cwd: INSTALL_DIR,
    stdio: 'inherit',
    windowsHide: true,
  });
  const forwardedSignals = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGHUP', 'SIGINT', 'SIGTERM'];

  for (const signal of forwardedSignals) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.once('error', (error) => {
    console.error(`Failed to start Excalidraw MCP: ${error.message}`);
    process.exitCode = 1;
  });

  child.once('exit', (code, signal) => {
    if (signal) {
      for (const forwardedSignal of forwardedSignals) process.removeAllListeners(forwardedSignal);
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code ?? 1;
  });
}

async function main() {
  await bootstrap();
  launch();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Failed to prepare Excalidraw MCP: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  INSTALL_DIR,
  buildIsCurrent,
  commandForPlatform,
  expectedBuildStamp,
  packageManager,
};
