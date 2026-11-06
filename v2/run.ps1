# Build (if needed) and run apx2.
# Usage: .\run.ps1 serve --listen 127.0.0.1:8787
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$exe = Join-Path $root 'bin\apx2.exe'
$go = Join-Path $env:LOCALAPPDATA 'Programs\Go\go\bin\go.exe'

$needBuild = -not (Test-Path $exe)
if (-not $needBuild) {
    $newest = Get-ChildItem -Path $root -Recurse -Filter *.go |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $needBuild = $newest -and $newest.LastWriteTime -gt (Get-Item $exe).LastWriteTime
}
if ($needBuild) {
    Push-Location $root
    try {
        & $go build -o $exe ./cmd/apx
    } finally {
        Pop-Location
    }
}

if ($args.Count -eq 0) { $args = @('serve') }
& $exe @args
