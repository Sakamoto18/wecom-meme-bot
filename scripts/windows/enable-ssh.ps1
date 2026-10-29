param(
    [string]$BundleRoot = $PSScriptRoot,
    [string]$BackupRoot = 'C:\migration-backup'
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
    ) -join "`r`n"
    [IO.File]::WriteAllText($config, ($settings + "`r`n" + $original), $utf8)
    Set-AdminOnlyAcl $config
    & $keygen -A
    if ($LASTEXITCODE -ne 0) { throw 'Could not generate SSH host keys.' }
    & $sshd -t -f $config
    if ($LASTEXITCODE -ne 0) { throw 'OpenSSH configuration validation failed.' }
    $effective = & $sshd -T -f $config -C 'user=administrator,host=localhost,addr=127.0.0.1'
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
    if ((Get-Service sshd).Status -ne 'Running') { throw 'SSH service did not start.' }
} catch {
    $failure = $_
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
