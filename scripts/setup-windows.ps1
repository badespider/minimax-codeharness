$ErrorActionPreference = 'Stop'

# Windows bootstrap for the public fork. The checkout and launcher are owned by
# the current user; no existing checkout, profile instruction, or command is replaced.
$script:ForkUrl = 'https://github.com/badespider/minimax-codeharness.git'
$script:ForkBranch = 'main'
$script:PnpmVersion = '9.12.0'

function Find-Application([string] $Name) {
    $working = [IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\')
    $homePath = [Environment]::GetFolderPath('UserProfile').TrimEnd('\')
    $driveRoot = [IO.Path]::GetPathRoot((Get-Location).Path).TrimEnd('\')
    foreach ($command in @(Get-Command $Name -All -CommandType Application -ErrorAction SilentlyContinue)) {
        $candidate = $command.Source
        if (-not [IO.Path]::IsPathRooted($candidate)) { continue }
        $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($candidate)).TrimEnd('\')
        $inWorkingDirectory = $parent.Equals($working, [StringComparison]::OrdinalIgnoreCase)
        if (-not ($working.Equals($homePath, [StringComparison]::OrdinalIgnoreCase) -or $working.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase))) {
            $inWorkingDirectory = $inWorkingDirectory -or $parent.StartsWith($working + '\', [StringComparison]::OrdinalIgnoreCase)
        }
        if (-not $inWorkingDirectory) { return $candidate }
    }
    return $null
}

function Add-RegisteredPathsToCurrentProcess {
    foreach ($scope in @('Machine', 'User')) {
        $registered = [Environment]::GetEnvironmentVariable('Path', $scope)
        if ($registered) { $env:Path += ';' + $registered }
    }
}

function Require-Application([string] $Name, [string] $WingetId, [string] $Label) {
    $found = Find-Application $Name
    if ($found) { return $found }
    $winget = Find-Application 'winget.exe'
    if (-not $winget) { throw "$Label is required. Install it, open a new PowerShell window, and run setup again. Windows Package Manager (winget) is unavailable." }
    Write-Host "Installing $Label with Windows Package Manager. Windows may ask for approval."
    & $winget install --exact --id $WingetId --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Could not install $Label (winget exit $LASTEXITCODE). Install it manually, open a new PowerShell window, and rerun setup." }
    Add-RegisteredPathsToCurrentProcess
    $found = Find-Application $Name
    if (-not $found) { throw "$Label was installed but is not on PATH yet. Open a new PowerShell window and rerun setup." }
    return $found
}

function Assert-NodeVersion([string] $Node) {
    $reported = (& $Node --version | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $reported -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { throw 'Unable to determine the Node.js version.' }
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]
    if (-not (($major -eq 22 -and $minor -ge 19) -or ($major -eq 24 -and $minor -ge 2) -or ($major -ge 25 -and $major -le 26))) {
        throw "Node.js $reported is not supported by this fork. Install Node.js 24 LTS, open a new terminal, and rerun setup."
    }
}

function Invoke-Checked([string] $Program, [string[]] $Arguments, [string] $Description) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Description failed (exit $LASTEXITCODE)." }
}

function Get-InstallRoot {
    if ($env:MINIMAX_HARNESS_HOME -and $env:MINIMAX_HARNESS_HOME.Trim()) { return [IO.Path]::GetFullPath($env:MINIMAX_HARNESS_HOME.Trim()) }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; run setup in a normal Windows user session.' }
    return Join-Path $env:LOCALAPPDATA 'MiniMaxCodeHarness'
}

function Register-UserPath([string] $Bin) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    $already = $false
    foreach ($part in $parts) { if ($part.Trim().TrimEnd('\') -ieq $Bin.TrimEnd('\')) { $already = $true; break } }
    if (-not $already) {
        $newPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $Bin } else { $Bin }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    }
    if (-not (@($env:Path -split ';') | Where-Object { $_.Trim().TrimEnd('\') -ieq $Bin.TrimEnd('\') })) { $env:Path += ';' + $Bin }
}

function Assert-NoCommandConflict([string] $ExpectedShim) {
    foreach ($command in @(Get-Command 'mcode-chatgpt' -All -ErrorAction SilentlyContinue)) {
        if ($command.CommandType -ne 'Application' -or $command.Source -ine $ExpectedShim) {
            throw 'A different mcode-chatgpt command is already available. It was not changed; remove or rename the conflict before setup.'
        }
    }
}

function Install-MiniMaxHarness {
    if ($env:OS -ne 'Windows_NT') { throw 'This ChatGPT-plan setup currently supports Windows only.' }
    $root = Get-InstallRoot
    if ($root -match '[%"\r\n]') { throw 'The install path contains characters unsupported by Windows command files. Set MINIMAX_HARNESS_HOME to a path without percent signs or quotes.' }
    $source = Join-Path $root 'source'
    $bin = Join-Path $root 'bin'
    $shim = Join-Path $bin 'mcode-chatgpt.cmd'
    $launcher = Join-Path $source 'scripts\windows\mcode-chatgpt.cmd'
    # Keep the shim ASCII and derive its sibling checkout at run time, so user
    # profiles containing non-ASCII characters are not corrupted during write.
    $shimContents = "@echo off`r`nsetlocal DisableDelayedExpansion`r`ncall `"%~dp0..\source\scripts\windows\mcode-chatgpt.cmd`" %*`r`nexit /b %ERRORLEVEL%`r`n"
    if (Test-Path -LiteralPath $shim) {
        if (-not (Test-Path -LiteralPath $shim -PathType Leaf) -or [IO.File]::ReadAllText($shim) -cne $shimContents) {
            throw "An existing command is at $shim. It was not changed; choose another MINIMAX_HARNESS_HOME or review the existing file."
        }
    }
    # A different command earlier on PATH would win even if our shim is added.
    Assert-NoCommandConflict $shim

    $git = Require-Application 'git.exe' 'Git.Git' 'Git'
    $node = Require-Application 'node.exe' 'OpenJS.NodeJS.LTS' 'Node.js LTS'
    Assert-NodeVersion $node
    $pnpm = Find-Application 'pnpm.cmd'
    $pnpmPrefix = @()
    if ($pnpm) {
        $version = (& $pnpm --version | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0 -or $version -ne $script:PnpmVersion) { $pnpm = $null }
    }
    if (-not $pnpm) {
        $pnpm = Find-Application 'npx.cmd'
        if (-not $pnpm) { throw 'Node.js npm/npx is required to run pnpm 9.12.0. Repair Node.js and rerun setup.' }
        $pnpmPrefix = @('--yes', "pnpm@$($script:PnpmVersion)")
    }

    if (Test-Path -LiteralPath $source) {
        if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) { throw "The existing path $source is not this fork checkout. It was not changed." }
        $origin = (& $git -C $source remote get-url origin | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0 -or $origin -ne $script:ForkUrl) { throw "The existing checkout at $source has a different origin. It was not changed." }
        $branch = (& $git -C $source branch --show-current | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0 -or $branch -ne $script:ForkBranch) { throw "The existing checkout at $source is not on $($script:ForkBranch). It was not changed." }
        $changes = @(& $git -C $source status --porcelain --untracked-files=normal)
        if ($LASTEXITCODE -ne 0 -or $changes.Count -gt 0) { throw "The existing checkout at $source has uncommitted changes or could not be checked. It was not changed." }
        Write-Host "Using the existing checkout at $source. Setup does not update or reset it."
    } else {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Invoke-Checked $git @('clone', '--branch', $script:ForkBranch, '--single-branch', $script:ForkUrl, $source) 'Cloning the fork'
    }

    Push-Location -LiteralPath $source
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $source 'dist\cli.js') -PathType Leaf)) {
            Invoke-Checked $pnpm ($pnpmPrefix + @('install', '--frozen-lockfile')) 'Installing dependencies'
            Invoke-Checked $pnpm ($pnpmPrefix + @('run', 'build')) 'Building MiniMax'
        } else {
            Write-Host 'An existing build was found; leaving it unchanged.'
        }
        Invoke-Checked $node @((Join-Path $source 'scripts\install-auto-workflow.mjs')) 'Installing the Auto workflow'
        if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'The fork does not contain the portable Windows launcher. No command was installed.' }
    } finally { Pop-Location }

    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    if (-not (Test-Path -LiteralPath $shim)) {
        $stream = [IO.File]::Open($shim, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $writer = New-Object IO.StreamWriter($stream, [Text.Encoding]::ASCII); try { $writer.Write($shimContents) } finally { $writer.Dispose() } }
        finally { $stream.Dispose() }
    }
    Register-UserPath $bin
    Write-Host 'Setup complete. Run mcode-chatgpt from your project folder; approve ChatGPT sign-in in the browser if asked.'
}

if ($MyInvocation.InvocationName -ne '.') { Install-MiniMaxHarness }
