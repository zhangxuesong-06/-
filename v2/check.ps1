# v2 baseline check: resolve Go, run tests and vet.
# Usage: powershell -ExecutionPolicy Bypass -File .\check.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$min = [version]'1.24'

function Resolve-Go {
    $cmd = Get-Command go -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Go\go\bin\go.exe'),
        'C:\Program Files\Go\bin\go.exe',
        'C:\Go\bin\go.exe',
        (Join-Path $env:USERPROFILE 'scoop\apps\go\current\bin\go.exe')
    )
    foreach ($p in $candidates) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    throw 'Go not found. Install Go 1.24+ or add go.exe to PATH.'
}

$go = Resolve-Go
$raw = ((& $go version) 2>&1 | Out-String).Trim()
Write-Host "Go: $raw"
$m = [regex]::Match($raw, 'go([0-9]+\.[0-9]+(?:\.[0-9]+)?)')
if (-not $m.Success) { throw "Cannot parse Go version: $raw" }
$got = [version]$m.Groups[1].Value
if ($got -lt $min) { throw "Need Go $min+, got $got" }

Push-Location $root
try {
    Write-Host "`n== go test ./... =="
    & $go test ./...
    if ($LASTEXITCODE -ne 0) { throw 'go test failed' }

    Write-Host "`n== go vet ./... =="
    & $go vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'go vet failed' }
} finally {
    Pop-Location
}

Write-Host "`nBaseline check passed."
