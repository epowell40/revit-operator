import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.existsSync(path.resolve('..', '..', 'scripts/register_local_desktop_launcher.ps1'))
  ? path.resolve('..', '..') : path.resolve('..');
const registration = path.join(root, 'scripts/register_local_desktop_launcher.ps1');
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

test('local launcher registration overrides a stale release without executing either launcher', { skip: process.platform !== 'win32' }, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-launcher-'));
  try {
    const current = path.join(fixture, "Current team's & build.ps1");
    fs.writeFileSync(current, 'throw "Registration must not launch or restart anything"');
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      '$ErrorActionPreference="Stop"; $env:OPERATOR_DESKTOP_LAUNCHER_PATH="C:\\old-release\\launch.ps1"; & $env:REGISTER_SCRIPT -LauncherPath $env:CURRENT_LAUNCHER -EnvironmentTarget Process; [Environment]::GetEnvironmentVariable("OPERATOR_DESKTOP_LAUNCHER_PATH","Process")'],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, REGISTER_SCRIPT: registration, CURRENT_LAUNCHER: current } });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    const receipt = JSON.parse(lines[0]!);
    assert.equal(receipt.previous_launcher_path, 'C:\\old-release\\launch.ps1');
    assert.equal(receipt.launcher_path, current);
    assert.equal(lines[1], current);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('missing and unsupported local launchers preserve the previous selection', { skip: process.platform !== 'win32' }, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-launcher-invalid-'));
  try {
    const wrongExtension = path.join(fixture, 'wrong.cmd');
    fs.writeFileSync(wrongExtension, '@echo off');
    for (const target of [path.join(fixture, 'missing.ps1'), wrongExtension, fixture]) {
      const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        '$env:OPERATOR_DESKTOP_LAUNCHER_PATH="preserve-me"; try { & $env:REGISTER_SCRIPT -LauncherPath $env:CURRENT_LAUNCHER -EnvironmentTarget Process; exit 9 } catch { [Environment]::GetEnvironmentVariable("OPERATOR_DESKTOP_LAUNCHER_PATH","Process") }'],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: { ...process.env, REGISTER_SCRIPT: registration, CURRENT_LAUNCHER: target } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'preserve-me');
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
