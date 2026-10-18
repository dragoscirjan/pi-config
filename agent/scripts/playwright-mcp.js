#!/usr/bin/env node

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const PACKAGE = '@playwright/mcp@latest';
const NIXOS_CHROMIUM = '/run/current-system/sw/bin/chromium';

function osReleaseId(contents) {
  const match = contents.match(/^\s*ID\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').toLowerCase();
}

function isNixOS({ platform = process.platform, readFileSync = fs.readFileSync, existsSync = fs.existsSync } = {}) {
  if (platform !== 'linux') return false;

  try {
    if (osReleaseId(readFileSync('/etc/os-release', 'utf8')) === 'nixos') return true;
  } catch {
    // Fall through to the legacy NixOS marker.
  }

  return existsSync('/etc/NIXOS');
}

function playwrightArgs(nixos = isNixOS()) {
  const args = ['-y', PACKAGE];

  if (nixos) {
    args.push('--browser', 'chromium', '--executable-path', NIXOS_CHROMIUM);
  }

  return args;
}

function launch() {
  const args = playwrightArgs();
  const windows = process.platform === 'win32';
  const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npx';
  const commandArgs = windows ? ['/d', '/s', '/c', ['npx', ...args].join(' ')] : args;
  const child = spawn(command, commandArgs, {
    stdio: 'inherit',
    windowsHide: true,
  });

  const forwardedSignals = windows ? ['SIGINT', 'SIGTERM'] : ['SIGHUP', 'SIGINT', 'SIGTERM'];

  for (const signal of forwardedSignals) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.on('error', (error) => {
    console.error(`Failed to start Playwright MCP: ${error.message}`);
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      for (const forwardedSignal of forwardedSignals) process.removeAllListeners(forwardedSignal);
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code ?? 1;
  });
}

if (require.main === module) launch();

module.exports = { isNixOS, osReleaseId, playwrightArgs };
