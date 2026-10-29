$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location $root

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE)." }
}

$node = 'C:\Program Files\nodejs\node.exe'
$npm = 'C:\Program Files\nodejs\npm.cmd'
if (-not (Test-Path $node)) { throw 'Install the Windows x64 Node.js 22 LTS MSI first.' }
$env:Path = "C:\Program Files\nodejs;$env:Path"
Invoke-Checked $node @('-e', 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<5)) process.exit(1)')
Invoke-Checked 'py.exe' @('-3.12', '-c', 'import sys; assert sys.platform == "win32" and sys.maxsize > 2**32')
if (-not (Test-Path '.env.qq')) { throw 'Restore .env.qq before installing the backend.' }

Invoke-Checked $npm @('ci', '--omit=dev', '--no-audit', '--no-fund')
if (-not (Test-Path '.venv-windows\Scripts\python.exe')) {
    Invoke-Checked 'py.exe' @('-3.12', '-m', 'venv', '.venv-windows')
}
$python = Join-Path $root '.venv-windows\Scripts\python.exe'
Invoke-Checked $python @('-m', 'pip', 'install', '--index-url', 'https://mirrors.cloud.tencent.com/pypi/simple', '-r', 'services/douyin-provider/requirements.txt', 'yt-dlp', 'requests==2.32.5')
Invoke-Checked $python @('-c', 'import fastapi, uvicorn, playwright; print("Python backend imports OK")')
Invoke-Checked $node @('-e', 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(":memory:"); console.log(db.prepare("select 1 as ok").get()); db.close()')
Write-Host 'Backend dependencies installed. Services have NOT been started. Restore SQLite before first launch.'
