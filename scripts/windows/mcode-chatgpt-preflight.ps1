$ErrorActionPreference = 'Stop'
$script:MiniMaxCli = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\dist\cli.js'))

function Test-IsWorkspaceExecutable([string] $Candidate, [string] $WorkingDirectory, [string] $UserHome) {
    $working = [IO.Path]::GetFullPath($WorkingDirectory).TrimEnd('\')
    $profilePath = [IO.Path]::GetFullPath($UserHome).TrimEnd('\')
    $root = [IO.Path]::GetPathRoot($WorkingDirectory).TrimEnd('\')
    $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Candidate)).TrimEnd('\')
    # A drive root or home directory is not a project boundary: excluding all
    # descendants there would reject ordinary user-scoped installations.
    if ($working.Equals($profilePath, [StringComparison]::OrdinalIgnoreCase) -or $working.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
        return $parent.Equals($working, [StringComparison]::OrdinalIgnoreCase)
    }
    return $parent.Equals($working, [StringComparison]::OrdinalIgnoreCase) -or $parent.StartsWith($working + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-TrustedNode {
    # PowerShell resolves applications from PATH. Ignore relative and
    # workspace-local candidates so a project cannot impersonate Node.
    foreach ($candidate in @(Get-Command node.exe -All -CommandType Application -ErrorAction SilentlyContinue)) {
        $path = $candidate.Source
        if (-not [IO.Path]::IsPathRooted($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $full = [IO.Path]::GetFullPath($path)
        if (Test-IsWorkspaceExecutable $full (Get-Location).Path ([Environment]::GetFolderPath('UserProfile'))) { continue }
        return $full
    }
    throw 'Node.js was not found on PATH outside the current project. Install a supported Node.js version and retry.'
}

function Invoke-MiniMax([string[]] $CliArgs) {
    $output = @(& $script:NodeExe $script:MiniMaxCli @CliArgs)
    if ($LASTEXITCODE -ne 0) { throw "MiniMax command failed (exit $LASTEXITCODE)." }
    return $output
}

function Get-MiniMaxChatGPTModel {
    $status = @(Invoke-MiniMax @('chatgpt', 'status')) -join "`n"
    if ($status -match '(?m)^ChatGPT authorization: (disconnected|failed)\s*$') {
        [Console]::Error.WriteLine('Opening ChatGPT sign-in. Approve the separate MiniMax connection in your browser.')
        Invoke-MiniMax @('chatgpt', 'connect') | ForEach-Object { [Console]::Error.WriteLine($_) }
        $status = @(Invoke-MiniMax @('chatgpt', 'status')) -join "`n"
    }
    if ($status -match '(?m)^ChatGPT authorization: plan-disabled\s*$') {
        [Console]::Error.WriteLine('Opening ChatGPT to enable plan usage for MiniMax.')
        Invoke-MiniMax @('chatgpt', 'enable-plan') | ForEach-Object { [Console]::Error.WriteLine($_) }
        $status = @(Invoke-MiniMax @('chatgpt', 'status')) -join "`n"
    }
    if ($status -notmatch '(?m)^ChatGPT authorization: connected\s*$') {
        throw 'ChatGPT authorization is not connected. Check the MiniMax ChatGPT sign-in and retry.'
    }
    $lines = @(Invoke-MiniMax @('chatgpt', 'models'))
    foreach ($line in $lines) {
        # Only accept a safe slug from an account-scoped selectable catalog.
        if ($line -match '^([A-Za-z0-9][A-Za-z0-9._-]*)\t') { return $Matches[1] }
    }
    throw 'No supported ChatGPT model is available for this account.'
}

function Start-MiniMaxChatGPTPreflight {
    if (-not (Test-Path -LiteralPath $script:MiniMaxCli -PathType Leaf)) { throw 'MiniMax is not built. Run the setup command again.' }
    $script:NodeExe = Get-TrustedNode
    $model = Get-MiniMaxChatGPTModel
    # A pipe cannot occur in a Windows file path or a validated slug.
    Write-Output "$script:NodeExe|$model"
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($args.Count) { throw 'This launcher does not accept arguments. Run it from your project directory.' }
        Start-MiniMaxChatGPTPreflight
    } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
}
