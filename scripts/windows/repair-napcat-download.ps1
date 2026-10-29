param(
    [string]$SetupRoot = 'C:\NapCatSetup',
    [string]$ShellZip = (Join-Path $PSScriptRoot 'NapCat.Shell.zip'),
    [switch]$RunInstaller
)
$ErrorActionPreference = 'Stop'
# Pinned to the official v4.18.41 release and the bundled OneKey installer.
$expectedSize = 35894640
$expectedHash = '6801f93e533846cea05f4f531874a0e84371ab2331c5585b57cd7e3b869cf96b'
$installerHash = 'c1545743f1f62c0aad892b3ad0a7b2fb40b263a841353748d303fec461a501f2'
$installer = Join-Path $SetupRoot 'NapCatInstaller.exe'
$target = Join-Path $SetupRoot 'NapCat.Shell.zip'

# Check the complete payload and known installer before replacing the cache.
if (-not (Test-Path -LiteralPath $ShellZip -PathType Leaf)) { throw "Missing payload: $ShellZip" }
if ((Get-Item -LiteralPath $ShellZip).Length -ne $expectedSize) { throw 'Incomplete NapCat payload. Download the complete repair kit.' }
if ((Get-FileHash -LiteralPath $ShellZip -Algorithm SHA256).Hash -ne $expectedHash) { throw 'NapCat payload checksum mismatch.' }
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Missing installer: $installer" }
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $installerHash) { throw 'Unexpected OneKey installer version. No files were changed.' }
if (@(Get-Process -Name NapCatInstaller -ErrorAction SilentlyContinue).Count -gt 0) { throw 'Close the failed NapCat installer first (press a key at its exit prompt).' }

if ((Test-Path -LiteralPath $target -PathType Leaf) -and
    ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -eq $expectedHash)) {
    Write-Host 'The cached NapCat archive is already complete.'
} else {
    $suffix = [Guid]::NewGuid().ToString('N')
    $staged = "$target.$suffix.tmp"
    $backup = "$target.$suffix.previous"
    $oldMoved = $false
    try {
        Copy-Item -LiteralPath $ShellZip -Destination $staged
        if ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Staged copy checksum mismatch.' }
        if (Test-Path -LiteralPath $target) {
            Move-Item -LiteralPath $target -Destination $backup
            $oldMoved = $true
        }
        Move-Item -LiteralPath $staged -Destination $target
    } catch {
        if ($oldMoved -and -not (Test-Path -LiteralPath $target)) {
            Move-Item -LiteralPath $backup -Destination $target
        }
        throw
    } finally {
        if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged }
    }
    if ($oldMoved) { Write-Host "Previous archive retained: $backup" }
}
Write-Host 'NAPCAT ARCHIVE OK. The downloaded QQ package and bot data were retained.'
if ($RunInstaller) {
    Push-Location $SetupRoot
    try {
        & $installer
        $installerExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    Write-Host "NapCat installer exit code: $installerExit. Verify its completion message before starting QQ."
    exit $installerExit
}
