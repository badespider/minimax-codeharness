import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts', 'setup-windows.ps1');
const fixture = mkdtempSync(join(tmpdir(), 'minimax-windows-setup-'));
after(() => {
  if (!resolve(fixture).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('Unexpected test cleanup target');
  rmSync(fixture, { recursive: true, force: true });
});
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

function run(body, name) {
  const driver = join(fixture, `${name}.ps1`);
  // Windows PowerShell 5 requires a BOM to read non-ASCII fixture paths as UTF-8.
  writeFileSync(driver, `\uFEFF\n$ErrorActionPreference = 'Stop'\n. ${quote(script)}\n${body}\n`);
  return spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', driver], { encoding: 'utf8' });
}

test('Windows setup installs to its own directory and safely reruns without rebuilding', { skip: process.platform !== 'win32' }, () => {
  const install = join(fixture, 'install with spaces & 中文');
  const r = run(`
$env:MINIMAX_HARNESS_HOME = ${quote(install)}
$script:steps = [Collections.Generic.List[string]]::new()
function Assert-NoCommandConflict([string] $ExpectedShim) {}
function Register-UserPath([string] $Bin) { $script:steps.Add('path') }
function Require-Application([string] $Name, [string] $WingetId, [string] $Label) { if ($Name -eq 'git.exe') { return 'FakeGit' }; return 'FakeNode' }
function Assert-NodeVersion([string] $Node) {}
function Find-Application([string] $Name) { if ($Name -eq 'npx.cmd') { return 'FakeNpx' }; return $null }
function FakeGit {
    $global:LASTEXITCODE = 0
    if ($args -contains 'get-url') { return $script:ForkUrl }
    if ($args -contains '--show-current') { return $script:ForkBranch }
}
function Invoke-Checked([string] $Program, [string[]] $Arguments, [string] $Description) {
    $script:steps.Add($Description)
    $source = Join-Path $env:MINIMAX_HARNESS_HOME 'source'
    if ($Description -eq 'Cloning the fork') {
        if ($Arguments[0] -ne 'clone' -or $Arguments[1] -ne '--branch' -or $Arguments[2] -ne 'main' -or $Arguments[3] -ne '--single-branch' -or $Arguments[4] -ne 'https://github.com/badespider/minimax-codeharness.git') { throw 'Setup did not clone the fork main branch.' }
        New-Item -ItemType Directory -Path (Join-Path $source '.git'), (Join-Path $source 'scripts\\windows') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $source 'scripts\\windows\\mcode-chatgpt.cmd'), ('@echo off' + [Environment]::NewLine + 'echo fixture launcher reached' + [Environment]::NewLine))
    }
    if ($Description -eq 'Installing dependencies' -and (($Arguments -join ' ') -notmatch '^--yes pnpm@9\\.12\\.0 install --frozen-lockfile$')) { throw 'Pinned pnpm fallback was not used.' }
    if ($Description -eq 'Building MiniMax') {
        New-Item -ItemType Directory -Path (Join-Path $source 'dist') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $source 'dist\\cli.js'), 'fixture')
    }
}
Install-MiniMaxHarness
Install-MiniMaxHarness
if (@($script:steps | Where-Object { $_ -eq 'Cloning the fork' }).Count -ne 1) { throw 'Unexpected clone count.' }
if (@($script:steps | Where-Object { $_ -eq 'Building MiniMax' }).Count -ne 1) { throw 'Existing build was replaced.' }
if (@($script:steps | Where-Object { $_ -eq 'Installing the Auto workflow' }).Count -ne 2) { throw 'Workflow installer did not run twice.' }
`, 'fresh');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const shim = readFileSync(join(install, 'bin', 'mcode-chatgpt.cmd'), 'utf8');
  assert.match(shim, /scripts\\windows\\mcode-chatgpt\.cmd/);
  assert.match(shim, /DisableDelayedExpansion/);
  assert.doesNotMatch(shim, /中文/);
  const launch = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${join(install, 'bin', 'mcode-chatgpt.cmd')}""`], { encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(launch.status, 0, launch.stderr + launch.stdout);
  assert.match(launch.stdout, /fixture launcher reached/);
});

test('existing unrelated checkout is left untouched', { skip: process.platform !== 'win32' }, () => {
  const install = join(fixture, 'unrelated');
  mkdirSync(join(install, 'source'), { recursive: true });
  const marker = join(install, 'source', 'my-file.txt');
  writeFileSync(marker, 'preserve me');
  const r = run(`
$env:MINIMAX_HARNESS_HOME = ${quote(install)}
function Assert-NoCommandConflict([string] $ExpectedShim) {}
function Require-Application([string] $Name, [string] $WingetId, [string] $Label) { return 'fixture' }
function Assert-NodeVersion([string] $Node) {}
function Find-Application([string] $Name) { if ($Name -eq 'npx.cmd') { return 'fixture' }; return $null }
try { Install-MiniMaxHarness; throw 'Expected refusal.' } catch { if ($_.Exception.Message -notmatch 'not this fork checkout') { throw } }
`, 'unrelated');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(marker, 'utf8'), 'preserve me');
});

test('unsupported Node is rejected and supported versions are accepted', { skip: process.platform !== 'win32' }, () => {
  const r = run(`
function NodeVersion { $global:LASTEXITCODE = 0; return $script:nodeVersion }
$script:nodeVersion = 'v24.2.0'; Assert-NodeVersion 'NodeVersion'
$script:nodeVersion = 'v22.19.0'; Assert-NodeVersion 'NodeVersion'
foreach ($v in @('v23.0.0', 'v22.18.0', 'v24.1.0', 'v27.0.0')) {
    $script:nodeVersion = $v
    try { Assert-NodeVersion 'NodeVersion'; throw 'Expected unsupported version failure.' } catch { if ($_.Exception.Message -notmatch 'not supported') { throw } }
}
`, 'version');
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('missing dependency uses winget only when available and refreshes PATH', { skip: process.platform !== 'win32' }, () => {
  const r = run(`
$script:installed = $false
$script:refreshed = $false
function Find-Application([string] $Name) {
    if ($Name -eq 'winget.exe') { return 'FakeWinget' }
    if ($Name -eq 'git.exe' -and $script:installed) { return 'FakeGit' }
    return $null
}
function FakeWinget {
    if (($args -join ' ') -notmatch '^install --exact --id Git\\.Git --silent --accept-package-agreements --accept-source-agreements$') { throw 'Unexpected winget invocation.' }
    $script:installed = $true
    $global:LASTEXITCODE = 0
}
function Add-RegisteredPathsToCurrentProcess { $script:refreshed = $true }
if ((Require-Application 'git.exe' 'Git.Git' 'Git') -ne 'FakeGit' -or -not $script:refreshed) { throw 'Dependency setup failed.' }
function Find-Application([string] $Name) { return $null }
try { Require-Application 'git.exe' 'Git.Git' 'Git'; throw 'Expected missing winget failure.' } catch { if ($_.Exception.Message -notmatch 'winget.*unavailable') { throw } }
`, 'winget');
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('an existing unrelated launcher is never overwritten', { skip: process.platform !== 'win32' }, () => {
  const install = join(fixture, 'conflicting-launcher');
  mkdirSync(join(install, 'bin'), { recursive: true });
  const shim = join(install, 'bin', 'mcode-chatgpt.cmd');
  writeFileSync(shim, 'personal launcher');
  const r = run(`
$env:MINIMAX_HARNESS_HOME = ${quote(install)}
try { Install-MiniMaxHarness; throw 'Expected refusal.' } catch { if ($_.Exception.Message -notmatch 'existing command') { throw } }
`, 'launcher');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(shim, 'utf8'), 'personal launcher');
});

test('a checkout with another origin is preserved', { skip: process.platform !== 'win32' }, () => {
  const install = join(fixture, 'other-origin');
  mkdirSync(join(install, 'source', '.git'), { recursive: true });
  const marker = join(install, 'source', 'personal.txt');
  writeFileSync(marker, 'do not change');
  const r = run(`
$env:MINIMAX_HARNESS_HOME = ${quote(install)}
function Assert-NoCommandConflict([string] $ExpectedShim) {}
function Require-Application([string] $Name, [string] $WingetId, [string] $Label) { if ($Name -eq 'git.exe') { return 'FakeGit' }; return 'FakeNode' }
function Assert-NodeVersion([string] $Node) {}
function Find-Application([string] $Name) { if ($Name -eq 'npx.cmd') { return 'FakeNpx' }; return $null }
function FakeGit { $global:LASTEXITCODE = 0; return 'https://github.com/someone-else/project.git' }
try { Install-MiniMaxHarness; throw 'Expected refusal.' } catch { if ($_.Exception.Message -notmatch 'different origin') { throw } }
`, 'origin');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(marker, 'utf8'), 'do not change');
});

test('an existing feature-branch checkout is preserved', { skip: process.platform !== 'win32' }, () => {
  const install = join(fixture, 'previous-feature-branch');
  mkdirSync(join(install, 'source', '.git'), { recursive: true });
  const marker = join(install, 'source', 'personal.txt');
  writeFileSync(marker, 'do not change');
  const r = run(`
$env:MINIMAX_HARNESS_HOME = ${quote(install)}
function Assert-NoCommandConflict([string] $ExpectedShim) {}
function Require-Application([string] $Name, [string] $WingetId, [string] $Label) { if ($Name -eq 'git.exe') { return 'FakeGit' }; return 'FakeNode' }
function Assert-NodeVersion([string] $Node) {}
function Find-Application([string] $Name) { if ($Name -eq 'npx.cmd') { return 'FakeNpx' }; return $null }
function FakeGit {
    $global:LASTEXITCODE = 0
    if ($args -contains 'get-url') { return $script:ForkUrl }
    if ($args -contains '--show-current') { return 'feat/agent-trust-foundations' }
    throw 'Unexpected Git operation on existing checkout.'
}
try { Install-MiniMaxHarness; throw 'Expected refusal.' } catch { if ($_.Exception.Message -notmatch 'not on main') { throw } }
`, 'previous-branch');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(marker, 'utf8'), 'do not change');
});

test('setup ignores executables planted in the current project', { skip: process.platform !== 'win32' }, () => {
  const project = join(fixture, 'untrusted-project');
  const trusted = join(fixture, 'trusted-bin');
  mkdirSync(project); mkdirSync(trusted);
  writeFileSync(join(project, 'fixture.exe'), 'untrusted');
  writeFileSync(join(trusted, 'fixture.exe'), 'trusted');
  const r = run(`
Set-Location -LiteralPath ${quote(project)}
$env:Path = ${quote(project)} + ';' + ${quote(trusted)} + ';' + $env:Path
$found = Find-Application 'fixture.exe'
if ($found -ne ${quote(join(trusted, 'fixture.exe'))}) { throw 'The project-local executable was not excluded.' }
`, 'path-spoof');
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
