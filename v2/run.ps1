# Build (if needed) and run apx2.
#   .\run.ps1                 -> serve (console)
#   .\run.ps1 app             -> standalone window
#   .\run.ps1 desktop         -> standalone window, detached (no console)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$exe = Join-Path $root 'bin\apx2.exe'
$gui = Join-Path $root 'bin\apx2w.exe'

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

$needBuild = (-not (Test-Path $exe)) -or (-not (Test-Path $gui))
if (-not $needBuild) {
    $newest = Get-ChildItem -Path $root -Recurse -Filter *.go |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $built = (Get-Item $exe).LastWriteTime
    if ((Get-Item $gui).LastWriteTime -lt $built) { $built = (Get-Item $gui).LastWriteTime }
    $needBuild = $newest -and $newest.LastWriteTime -gt $built
}
if ($needBuild) {
    $go = Resolve-Go
    Push-Location $root
    try {
        & $go build -o $exe ./cmd/apx
        & $go build -ldflags '-H windowsgui' -o $gui ./cmd/apx
    } finally {
        Pop-Location
    }
}

if ($args.Count -eq 0) { $args = @('serve') }

if ($args[0] -eq 'desktop') {
    Start-Process -FilePath $gui -ArgumentList 'app' -WorkingDirectory $root
    exit 0
}

& $exe @args
