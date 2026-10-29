param(
    [string]$ProjectRoot = 'C:\longtu-qq-bot',
    [string]$BundleRoot = $PSScriptRoot,
    [string]$BackupRoot = 'C:\migration-backup'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $ProjectRoot 'package.json'))) { throw 'Restore the project first.' }
$manifest = Get-Content (Join-Path $BundleRoot 'PROJECT-PATCH.json') -Raw | ConvertFrom-Json
# Validate the entire patch and restored source before modifying any file.
foreach ($item in $manifest.files) {
    $source = Join-Path (Join-Path $BundleRoot 'project-patch') $item.path
    $target = Join-Path $ProjectRoot $item.path
    if ((Get-FileHash $source -Algorithm SHA256).Hash -ne $item.sha256) { throw "Patch checksum mismatch: $($item.path)" }
    if (Test-Path $target) {
        $actual = (Get-FileHash $target -Algorithm SHA256).Hash
        if ($actual -ne $item.sha256 -and $actual -ne $item.beforeSha256) {
            throw "Restored source differs from this patch: $($item.path). No files were changed."
        }
    } elseif ($item.beforeSha256) {
        throw "Missing restored source: $($item.path). No files were changed."
    }
}
$backup = Join-Path $BackupRoot ("code-before-native-" + [Guid]::NewGuid().ToString('N'))
foreach ($item in $manifest.files) {
    $source = Join-Path (Join-Path $BundleRoot 'project-patch') $item.path
    $target = Join-Path $ProjectRoot $item.path
    if (Test-Path $target) {
        if ((Get-FileHash $target -Algorithm SHA256).Hash -eq $item.sha256) { continue }
        $old = Join-Path $backup $item.path
        New-Item -ItemType Directory -Force (Split-Path $old -Parent) | Out-Null
        Copy-Item $target $old
    }
    New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
    Copy-Item $source $target -Force
    if ((Get-FileHash $target -Algorithm SHA256).Hash -ne $item.sha256) { throw "Installed file check failed: $($item.path)" }
}
Write-Host "PROJECT PATCH OK. Original files: $backup. No services were started."
