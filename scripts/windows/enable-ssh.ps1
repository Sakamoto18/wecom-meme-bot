param(
    [string]$BundleRoot = $PSScriptRoot,
    [string]$BackupRoot = 'C:\migration-backup',
    [switch]$Diagnostics
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated Administrator PowerShell.'
}
$bin = Join-Path $env:WINDIR 'System32\OpenSSH'
$sshd = Join-Path $bin 'sshd.exe'
$keygen = Join-Path $bin 'ssh-keygen.exe'
if (-not (Test-Path -LiteralPath $sshd)) { throw 'Install OpenSSH.Server first.' }
$service = Get-Service sshd
if ($service.Status -ne 'Stopped') { throw 'This bootstrap is for the new, stopped SSH service only.' }
$publicKeyFile = Join-Path $BundleRoot 'deploy-key.pub'
$manifest = Get-Content -LiteralPath (Join-Path $BundleRoot 'SSH-SETUP.json') -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $publicKeyFile -Algorithm SHA256).Hash -ne $manifest.publicKeySha256) {
    throw 'Public key checksum mismatch.'
}
if ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash -ne $manifest.scriptSha256) {
    throw 'Bootstrap script checksum mismatch.'
}
$key = (Get-Content -LiteralPath $publicKeyFile -Raw).Trim()
if ($key -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$') { throw 'Invalid deployment public key.' }
$fingerprint = & $keygen -lf $publicKeyFile
if ($LASTEXITCODE -ne 0 -or $fingerprint -notlike "* $($manifest.publicKeyFingerprint) *") {
    throw 'Deployment public key fingerprint mismatch.'
}

function Set-AdminOnlyAcl([string]$Path) {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $acl.SetOwner($admins)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-32-544', 'S-1-5-18')) {
        $who = [Security.Principal.SecurityIdentifier]::new($sid)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($who, 'FullControl', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

$sshRoot = Join-Path $env:ProgramData 'ssh'
New-Item -ItemType Directory -Path $sshRoot -Force | Out-Null
$config = Join-Path $sshRoot 'sshd_config'
$authorized = Join-Path $sshRoot 'administrators_authorized_keys'
$backup = Join-Path $BackupRoot ('ssh-before-native-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$previous = @{}
foreach ($file in @($config, $authorized)) {
    $previous[$file] = Test-Path -LiteralPath $file
    if ($previous[$file]) {
        Copy-Item -LiteralPath $file -Destination $backup
        (Get-Acl -LiteralPath $file).Sddl | Set-Content -LiteralPath (Join-Path $backup ((Split-Path $file -Leaf) + '.sddl'))
    }
}
$utf8 = [Text.UTF8Encoding]::new($false)
$runStarted = Get-Date
$reportPath = Join-Path $backup 'ssh-diagnostic.txt'
$serverLog = Join-Path $sshRoot 'logs\sshd.log'

function Write-StartupReport([string]$Outcome) {
    $sections = [Collections.Generic.List[string]]::new()
    $sections.Add("SSH startup diagnostic: $Outcome`r`nStarted: $($runStarted.ToString('o'))")
    $checks = [ordered]@{
        'Windows and binary version' = {
            Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' |
                Select-Object -Property @('ProductName', 'CurrentBuild', 'UBR') | Format-List
            (Get-Item -LiteralPath $sshd).VersionInfo |
                Select-Object -Property @('FileVersion', 'ProductVersion') | Format-List
        }
        'Service state before rollback' = {
            Get-CimInstance Win32_Service -Filter "Name='sshd'" |
                Select-Object -Property @('State', 'StartMode', 'ExitCode', 'ServiceSpecificExitCode', 'ProcessId', 'PathName', 'StartName') | Format-List
        }
        'Owners and permissions (no key contents)' = {
            $paths = @($sshRoot, (Join-Path $sshRoot 'logs'), $config, $authorized)
            $paths += @(Get-ChildItem -LiteralPath $sshRoot -Filter 'ssh_host_*_key' -File | ForEach-Object FullName)
            foreach ($path in $paths) {
                if (Test-Path -LiteralPath $path) {
                    $acl = Get-Acl -LiteralPath $path
                    [pscustomobject]@{ Path = $path; Owner = $acl.Owner; Sddl = $acl.Sddl } | Format-List
                } else { "Missing: $path" }
            }
        }
        'TCP 22 listeners' = {
            Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue |
                Select-Object -Property @('LocalAddress', 'LocalPort', 'OwningProcess') | Format-Table
        }
        'New OpenSSH file log (last 100 lines)' = {
            if ((Test-Path -LiteralPath $serverLog) -and
                (Get-Item -LiteralPath $serverLog).LastWriteTime -ge $runStarted) {
                Get-Content -LiteralPath $serverLog -Tail 100
            } else { 'No OpenSSH file log written during this attempt.' }
        }
    }
    foreach ($name in $checks.Keys) {
        $sections.Add("`r`n=== $name ===")
        try { $sections.Add((& $checks[$name] | Out-String -Width 220).TrimEnd()) }
        catch { $sections.Add("Could not collect this section: $($_.Exception.Message)") }
    }
    foreach ($channel in @('OpenSSH/Admin', 'OpenSSH/Operational', 'System', 'Application')) {
        $sections.Add("`r`n=== Recent events: $channel ===")
        $filter = @{ LogName = $channel; StartTime = $runStarted.AddMinutes(-1) }
        if ($channel -eq 'System') { $filter.ProviderName = 'Service Control Manager' }
        if ($channel -eq 'Application') { $filter.Id = @(1000, 1001) }
        try {
            $events = Get-WinEvent -FilterHashtable $filter -MaxEvents 12 -ErrorAction Stop
            $sections.Add(($events | Select-Object -Property @('TimeCreated', 'Id', 'ProviderName', 'Message') |
                Format-List | Out-String -Width 220).TrimEnd())
        } catch { $sections.Add("No events available: $($_.Exception.Message)") }
    }
    [IO.File]::WriteAllText($reportPath, ($sections -join "`r`n"), $utf8)
    Set-AdminOnlyAcl $reportPath
    # Keep the unique report in the backup; also provide a short, predictable path for VNC users.
    $latestReport = Join-Path $BundleRoot 'ssh-diagnostic.txt'
    Copy-Item -LiteralPath $reportPath -Destination $latestReport -Force
    Set-AdminOnlyAcl $latestReport
    Write-Host "DIAGNOSTIC REPORT: $latestReport"
    if ((Test-Path -LiteralPath $serverLog) -and
        (Get-Item -LiteralPath $serverLog).LastWriteTime -ge $runStarted) {
        Write-Host 'LAST SSH LOG LINES:'
        Get-Content -LiteralPath $serverLog -Tail 20 | ForEach-Object { Write-Host $_ }
    }
}

function Assert-SshReady {
    # Start-Service can return before a process exits. Require five seconds of stable service state.
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        Start-Sleep -Milliseconds 500
        if ((Get-Service sshd).Status -ne 'Running') { throw 'SSH service exited shortly after startup.' }
    }
    $runningService = Get-CimInstance Win32_Service -Filter "Name='sshd'"
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -eq $runningService.ProcessId })
    if ($listeners.Count -eq 0) { throw 'The SSH service is running but does not own a TCP 22 listener.' }
}

$firewallCreated = $false
$oldStartMode = (Get-CimInstance Win32_Service -Filter "Name='sshd'").StartMode
$oldStartType = if ($oldStartMode -eq 'Auto') { 'Automatic' } else { $oldStartMode }
$newRule = 'Longtu-Windows-SSH'
try {
    $existingKeys = if ($previous[$authorized]) { [IO.File]::ReadAllText($authorized) } else { '' }
    $keyBody = $key.Split(' ')[1]
    if ($existingKeys -notmatch [regex]::Escape($keyBody)) {
        [IO.File]::WriteAllText($authorized, ($existingKeys.TrimEnd() + "`r`n" + $key + "`r`n"), $utf8)
    }
    Set-AdminOnlyAcl $authorized

    $baseFile = if ($previous[$config]) { $config } else { Join-Path $bin 'sshd_config_default' }
    $original = [IO.File]::ReadAllText($baseFile)
    $settings = @(
        '# Longtu Windows maintenance: public-key authentication only.'
        'Port 22'
        'PubkeyAuthentication yes'
        'PasswordAuthentication no'
        'AuthenticationMethods publickey'
        'AllowUsers administrator'
    )
    if ($Diagnostics) {
        # File logging also works when the OpenSSH event channels are empty.
        $settings += @('SyslogFacility LOCAL0', 'LogLevel DEBUG3')
    }
    $settings = $settings -join "`r`n"
    [IO.File]::WriteAllText($config, ($settings + "`r`n" + $original), $utf8)
    Set-AdminOnlyAcl $config
    & $keygen -A
    if ($LASTEXITCODE -ne 0) { throw 'Could not generate SSH host keys.' }
    # Suppress DEBUG3 stderr during validation; PowerShell 5.1 can treat native stderr as an error.
    & $sshd -t -f $config -o 'LogLevel=ERROR'
    if ($LASTEXITCODE -ne 0) { throw 'OpenSSH configuration validation failed.' }
    $effective = & $sshd -T -f $config -o 'LogLevel=ERROR' -C 'user=administrator,host=localhost,addr=127.0.0.1'
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect effective SSH configuration.' }
    foreach ($line in @('passwordauthentication no', 'pubkeyauthentication yes', 'authenticationmethods publickey')) {
        if ($effective -notcontains $line) { throw "Unexpected SSH authentication setting: $line" }
    }
    if (-not ($effective -match '^authorizedkeysfile .*administrators_authorized_keys')) {
        throw 'Administrator authorized-key path is unexpected; no service was started.'
    }
    if (-not (Get-NetFirewallRule -Name $newRule -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name $newRule -DisplayName 'Longtu Windows SSH' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
        $firewallCreated = $true
    }
    Set-Service -Name sshd -StartupType Automatic
    Start-Service sshd
    Assert-SshReady
    if ($Diagnostics) {
        Write-StartupReport 'Diagnostic startup passed; checking normal logging next.'
        Stop-Service sshd
        $normalSettings = $settings.Replace('LogLevel DEBUG3', 'LogLevel INFO')
        [IO.File]::WriteAllText($config, ($normalSettings + "`r`n" + $original), $utf8)
        & $sshd -t -f $config
        if ($LASTEXITCODE -ne 0) { throw 'Normal logging configuration validation failed.' }
        Start-Service sshd
        Assert-SshReady
        Write-Host 'Normal INFO file logging enabled; verbose startup logging has been disabled.'
    }
} catch {
    $failure = $_
    # Capture the original exit status and fresh logs BEFORE stopping or restoring anything.
    try { Write-StartupReport $failure.Exception.Message }
    catch { Write-Warning "Could not save startup diagnostic: $($_.Exception.Message)" }
    if ((Get-Service sshd).Status -ne 'Stopped') { Stop-Service sshd -Force }
    if ($firewallCreated) { Remove-NetFirewallRule -Name $newRule }
    Set-Service -Name sshd -StartupType $oldStartType
    foreach ($file in @($config, $authorized)) {
        if ($previous[$file]) {
            Copy-Item -LiteralPath (Join-Path $backup (Split-Path $file -Leaf)) -Destination $file -Force
            $acl = [Security.AccessControl.FileSecurity]::new()
            $sddl = (Get-Content -LiteralPath (Join-Path $backup ((Split-Path $file -Leaf) + '.sddl')) -Raw).Trim()
            $acl.SetSecurityDescriptorSddlForm($sddl)
            Set-Acl -LiteralPath $file -AclObject $acl
        } elseif (Test-Path -LiteralPath $file) {
            Remove-Item -LiteralPath $file
        }
    }
    throw $failure
}
Write-Host 'SSH READY. Port 22. Administrator public-key login only. No reboot needed.'
Write-Host "Previous configuration: $backup"
Write-Host 'SERVER HOST KEY FINGERPRINT (send this line back for verification):'
& $keygen -lf (Join-Path $sshRoot 'ssh_host_ed25519_key.pub')
if ($LASTEXITCODE -ne 0) { throw 'SSH is running, but its host fingerprint could not be read.' }
