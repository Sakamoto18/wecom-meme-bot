param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('node', 'provider', 'astrbot', 'napcat', 'relay')]
    [string]$Mode,
    [string]$ProjectRoot = ''
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
}
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$launcher = Join-Path $ProjectRoot 'scripts\windows\run.mjs'
if (-not (Test-Path -LiteralPath $node)) { throw 'Native Node.js is not installed.' }
if (-not (Test-Path -LiteralPath $launcher)) { throw 'Windows service launcher is missing.' }
$logDir = Join-Path $ProjectRoot 'data\windows\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
# Each component owns its logs; locked files from a running process are retained.
Get-ChildItem -LiteralPath $logDir -Filter "$Mode-*.log" -File |
    Where-Object LastWriteTime -lt (Get-Date).AddDays(-14) |
    Remove-Item -Force -ErrorAction SilentlyContinue
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$out = Join-Path $logDir "$Mode-$stamp.out.log"
$err = Join-Path $logDir "$Mode-$stamp.err.log"
# Use separate log files and native process APIs so stderr does not terminate PowerShell 5.1.
$child = Start-Process -FilePath $node -ArgumentList @(('"' + $launcher + '"'), $Mode) `
    -WorkingDirectory $ProjectRoot -NoNewWindow -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
try {
    # Cache the native handle before waiting. PowerShell 5.1 can otherwise lose
    # ExitCode and report a crash as success, preventing Task Scheduler retries.
    $null = $child.Handle
    $child.WaitForExit()
    if ($null -eq $child.ExitCode) { throw 'Child exit status is unavailable.' }
    exit $child.ExitCode
} finally {
    $child.Dispose()
}
