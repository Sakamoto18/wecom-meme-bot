param(
    [ValidateSet('node', 'provider', 'astrbot', 'napcat', 'relay')]
    [string[]]$Modes = @('node', 'provider', 'astrbot', 'napcat')
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run from an elevated Administrator PowerShell.'
}
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runner = Join-Path $PSScriptRoot 'task-run.ps1'
foreach ($file in @($runner, (Join-Path $root '.env.qq'), (Join-Path $env:ProgramFiles 'nodejs\node.exe'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing prerequisite: $file" }
}
$names = @{ node = 'Longtu-Backend'; provider = 'Longtu-Provider'; astrbot = 'Longtu-AstrBot'; napcat = 'Longtu-NapCat'; relay = 'Longtu-OneBot-Relay' }
$backup = Join-Path $root ('data\windows\task-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
foreach ($mode in ($Modes | Select-Object -Unique)) {
    $name = $names[$mode]
    $existing = Get-ScheduledTask -TaskPath '\' -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
        Export-ScheduledTask -TaskPath '\' -TaskName $name | Set-Content -LiteralPath (Join-Path $backup "$name.xml") -Encoding UTF8
    }
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '" -Mode ' + $mode
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument $arguments -WorkingDirectory $root
    Register-ScheduledTask -TaskPath '\' -TaskName $name -Action $action -Principal $principal `
        -Trigger $trigger -Settings $settings -Description 'Native Windows bot component; starts when the deployment user signs in.' -Force | Out-Null
    Write-Output "Registered $name for $($identity.Name) logon."
}
Write-Output "Existing task definitions saved to $backup"
Write-Output 'Registration does not stop or start running processes. Stop any manual instances before starting these tasks.'
