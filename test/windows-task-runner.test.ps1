$ErrorActionPreference = 'Stop'
$runner = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\windows\task-run.ps1'
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('longtu-task-test-' + [guid]::NewGuid().ToString('N'))
try {
    $sourceDir = Join-Path $testRoot 'scripts\windows'
    New-Item -ItemType Directory -Path $sourceDir -Force | Out-Null
    foreach ($expected in @(0, 7)) {
        $source = 'process.stdout.write("stdout-' + $expected + '\n"); process.stderr.write("stderr-' + $expected + '\n"); process.exit(' + $expected + ');'
        $source | Set-Content -LiteralPath (Join-Path $sourceDir 'run.mjs') -Encoding ASCII
        & $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner -Mode node -ProjectRoot $testRoot
        if ($LASTEXITCODE -ne $expected) { throw "Expected exit $expected; got $LASTEXITCODE" }
        foreach ($stream in @('out', 'err')) {
            $log = Get-ChildItem -LiteralPath (Join-Path $testRoot 'data\windows\logs') -Filter "node-*.$stream.log" |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            $content = Get-Content -LiteralPath $log.FullName -Raw
            if ($content.Trim() -ne "std$stream-$expected") { throw "Missing $stream log for exit $expected" }
        }
    }
    Write-Output 'Task runner passed: exit 0/7 and separate stdout/stderr logs.'
} finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
