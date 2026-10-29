param([string]$BundleRoot = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open PowerShell as Administrator and run this script again.'
}
$manifest = Get-Content (Join-Path $BundleRoot 'INSTALLER-HASHES.json') -Raw | ConvertFrom-Json
$nodeName = 'node-v22.23.4-x64.msi'
$pythonName = 'python-3.12.10-amd64.exe'
foreach ($name in @($nodeName, $pythonName)) {
    $file = Join-Path $BundleRoot "installers\$name"
    $expected = @($manifest | Where-Object { $_.name -eq $name })
    if ($expected.Count -ne 1) { throw "Missing checksum: $name" }
    if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $expected[0].sha256) {
        throw "Checksum mismatch: $name"
    }
    $signature = Get-AuthenticodeSignature $file
    if ($signature.Status -ne 'Valid') { throw "Windows signature validation failed: $name ($($signature.Status))" }
    Write-Host "Verified: $name | $($signature.SignerCertificate.Subject)"
}

$nodeFile = Join-Path $BundleRoot "installers\$nodeName"
$process = Start-Process msiexec.exe -ArgumentList @('/i', "`"$nodeFile`"", '/qn', '/norestart') -Wait -PassThru
if ($process.ExitCode -notin @(0, 3010)) { throw "Node.js installation failed: $($process.ExitCode)" }
$restartNeeded = $process.ExitCode -eq 3010
$pythonFile = Join-Path $BundleRoot "installers\$pythonName"
$process = Start-Process $pythonFile -ArgumentList @('/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_launcher=1', 'InstallLauncherAllUsers=1', 'Include_test=0', 'TargetDir=C:\Python312') -Wait -PassThru
if ($process.ExitCode -notin @(0, 3010)) { throw "Python installation failed: $($process.ExitCode)" }
$restartNeeded = $restartNeeded -or ($process.ExitCode -eq 3010)
& 'C:\Program Files\nodejs\node.exe' --version
if ($LASTEXITCODE -ne 0) { throw 'Node.js verification failed.' }
& 'C:\Python312\python.exe' --version
if ($LASTEXITCODE -ne 0) { throw 'Python verification failed.' }
Write-Host "RUNTIMES OK. RestartRequired=$restartNeeded. Bot services are not started."
