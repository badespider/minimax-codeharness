import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = join(root, 'scripts', 'windows', 'mcode-chatgpt-preflight.ps1');
const launcher = join(root, 'scripts', 'windows', 'mcode-chatgpt.cmd');
const win = process.platform === 'win32';

function runPowerShell(body) {
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `. '${helper.replaceAll("'", "''")}'\n${body}\nexit 0`;
  return spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
}

test('workspace executable guard keeps project tools out but allows normal home installs', { skip: !win }, () => {
  const result = runPowerShell(String.raw`
    if (-not (Test-IsWorkspaceExecutable 'C:\work\project\bin\node.exe' 'C:\work\project' 'C:\Users\Me')) { throw 'project executable accepted' }
    if (Test-IsWorkspaceExecutable 'C:\work\project-other\node.exe' 'C:\work\project' 'C:\Users\Me') { throw 'sibling rejected' }
    if (Test-IsWorkspaceExecutable 'C:\Users\Me\scoop\node.exe' 'C:\Users\Me' 'C:\Users\Me') { throw 'home installation rejected' }
    if (Test-IsWorkspaceExecutable 'C:\Users\Me\scoop\node.exe' 'C:\' 'C:\Users\Me') { throw 'drive root rejected' }
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('connected, disconnected and identity-only sessions choose an account-scoped model', { skip: !win }, () => {
  const result = runPowerShell(String.raw`
    $script:Calls = @(); $script:State = 'connected'
    function Invoke-MiniMax([string[]] $CliArgs) {
      $action = $CliArgs -join ' '; $script:Calls += $action
      switch ($action) {
        'chatgpt status' { return "ChatGPT authorization: $script:State" }
        'chatgpt connect' { $script:State = 'connected'; return 'connected' }
        'chatgpt enable-plan' { $script:State = 'connected'; return 'connected' }
        'chatgpt models' { return @(('gpt-6.1-sol' + [char]9 + 'GPT-6.1 Sol'), ('gpt-6-astra' + [char]9 + 'GPT-6 Astra')) }
        default { throw 'unexpected call' }
      }
    }
    foreach ($initial in @('connected', 'disconnected', 'plan-disabled')) {
      $script:State = $initial; $script:Calls = @()
      if ((Get-MiniMaxChatGPTModel) -ne 'gpt-6.1-sol') { throw 'wrong model' }
      if ($initial -eq 'disconnected' -and $script:Calls -notcontains 'chatgpt connect') { throw 'missing connect' }
      if ($initial -eq 'plan-disabled' -and $script:Calls -notcontains 'chatgpt enable-plan') { throw 'missing consent' }
    }
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('missing connection or invalid catalog fails without choosing a fallback', { skip: !win }, () => {
  const result = runPowerShell(String.raw`
    function Invoke-MiniMax([string[]] $CliArgs) {
      if (($CliArgs -join ' ') -eq 'chatgpt status') { return 'ChatGPT authorization: connected' }
      return @('No supported ChatGPT models are available.', ('unsafe&model' + [char]9 + 'Bad'))
    }
    try { $null = Get-MiniMaxChatGPTModel; throw 'unexpected success' }
    catch { if ($_.Exception.Message -notmatch 'No supported ChatGPT model') { throw } }
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('launcher executes Node directly with the explicit ChatGPT provider', () => {
  const text = readFileSync(launcher, 'utf8');
  assert.match(text, /DisableDelayedExpansion/);
  assert.match(text, /"%MINIMAX_CHATGPT_NODE%"[^\n]+-m "openai-siwc-experimental\/%MINIMAX_CHATGPT_MODEL%"/);
  assert.match(text, /if not defined MINIMAX_CHATGPT_MODEL exit \/b 1/);
});

test('launcher supports a Unicode install and Node path with spaces and ampersands', { skip: !win }, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'mcode-launcher-'));
  try {
    const install = join(fixture, '工具 & space', 'source');
    const scripts = join(install, 'scripts', 'windows');
    const nodeBin = join(fixture, '用户 node');
    const workspace = join(fixture, 'workspace');
    mkdirSync(scripts, { recursive: true }); mkdirSync(join(install, 'dist')); mkdirSync(nodeBin); mkdirSync(workspace);
    copyFileSync(launcher, join(scripts, 'mcode-chatgpt.cmd'));
    copyFileSync(helper, join(scripts, 'mcode-chatgpt-preflight.ps1'));
    linkSync(process.execPath, join(nodeBin, 'node.exe'));
    writeFileSync(join(install, 'dist', 'cli.js'), `
      if (process.argv[2] === 'chatgpt' && process.argv[3] === 'status') console.log('ChatGPT authorization: connected');
      else if (process.argv[2] === 'chatgpt' && process.argv[3] === 'models') console.log('gpt-6.1-sol\\tGPT-6.1 Sol');
      else if (process.argv[2] === '-m' && process.argv[3] === 'openai-siwc-experimental/gpt-6.1-sol' && process.execPath.includes('用户 node')) console.log('LAUNCH_OK');
      else process.exitCode = 1;
    `);
    const cmd = join(process.env.SystemRoot, 'System32', 'cmd.exe');
    const result = spawnSync(cmd, ['/d', '/s', '/c', `""${join(scripts, 'mcode-chatgpt.cmd')}""`], {
      cwd: workspace, env: { ...process.env, PATH: `${nodeBin};${process.env.PATH}` }, encoding: 'utf8', windowsVerbatimArguments: true,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /LAUNCH_OK/);
    const unexpectedArg = spawnSync(cmd, ['/d', '/s', '/c', `""${join(scripts, 'mcode-chatgpt.cmd')}" ignored"`], {
      cwd: workspace, env: { ...process.env, PATH: `${nodeBin};${process.env.PATH}` }, encoding: 'utf8', windowsVerbatimArguments: true,
    });
    assert.equal(unexpectedArg.status, 2, unexpectedArg.stderr);
    assert.match(unexpectedArg.stderr, /does not accept arguments/);
  } finally {
    // Remove only this newly-created fixture under the system temporary directory.
    if (!fixture.startsWith(join(tmpdir(), 'mcode-launcher-'))) throw new Error('Unexpected fixture path');
    rmSync(fixture, { recursive: true, force: true });
  }
});
