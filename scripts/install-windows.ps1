# Richtet den YouTube Downloader unter Windows ein.
#
# Fehlt yt-dlp, ffmpeg oder Python, wird das Fehlende neben den Host gelegt.
# Es wird nichts systemweit installiert und keine Administratorrechte
# benötigt — alles landet im Ordner dieser Erweiterung bzw. unter dem
# Benutzerkonto.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # sonst bremst die Fortschrittsanzeige den Download aus

$Root     = Split-Path -Parent $PSScriptRoot
$HostName = 'com.yannik.ytdl_host'
$HostPy   = Join-Path $Root 'native-host\ytdl_host.py'
$BinDir   = Join-Path $Root 'native-host\bin'
$IdFile   = Join-Path $Root 'keys\extension_id.txt'
$Manifest = Join-Path $Root "native-host\$HostName.json"

function Write-Head($text) { Write-Host ''; Write-Host $text -ForegroundColor White }
function Write-Ok($text)   { Write-Host "  [ok] $text" -ForegroundColor Green }
function Write-Info($text) { Write-Host "       $text" -ForegroundColor DarkGray }
function Write-Warn($text) { Write-Host "  [!]  $text" -ForegroundColor Yellow }
function Write-Fail($text) { Write-Host "  [x]  $text" -ForegroundColor Red }

function Stop-Here($message) {
    Write-Host ''
    Write-Fail $message
    Write-Host ''
    Read-Host 'Enter zum Schliessen'
    exit 1
}

Write-Host ''
Write-Host 'YouTube Downloader - Einrichtung fuer Windows' -ForegroundColor White
Write-Host ''

if (-not (Test-Path $HostPy)) {
    Stop-Here "native-host\ytdl_host.py fehlt. Wurde das ZIP vollstaendig entpackt?"
}
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# ------------------------------------------------------------- 1. Werkzeuge ---

Write-Head '1. Werkzeuge'

function Find-Tool($name) {
    $local = Join-Path $BinDir "$name.exe"
    if (Test-Path $local) { return $local }
    $found = Get-Command "$name.exe" -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    return $null
}

function Get-File($url, $target) {
    Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing -TimeoutSec 900
}

# --- yt-dlp: eine einzelne exe, enthaelt sein Python selbst ---
$ytdlp = Find-Tool 'yt-dlp'
if ($ytdlp) {
    Write-Ok "yt-dlp gefunden  ->  $ytdlp"
} else {
    Write-Warn 'yt-dlp fehlt, wird geholt (rund 18 MB)'
    Get-File 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' `
             (Join-Path $BinDir 'yt-dlp.exe')
    $ytdlp = Join-Path $BinDir 'yt-dlp.exe'
    Write-Ok "yt-dlp bereit  ->  $ytdlp"
}

# --- ffmpeg ---
$ffmpeg = Find-Tool 'ffmpeg'
if ($ffmpeg) {
    Write-Ok "ffmpeg gefunden  ->  $ffmpeg"
} else {
    Write-Warn 'ffmpeg fehlt, wird geholt (rund 106 MB, das dauert einen Moment)'
    $tmp = Join-Path $env:TEMP ("ytdl-ffmpeg-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zip = Join-Path $tmp 'ffmpeg.zip'
    Get-File 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $zip
    Write-Info 'Entpacke ...'
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    foreach ($tool in @('ffmpeg.exe', 'ffprobe.exe')) {
        $src = Get-ChildItem -Path $tmp -Filter $tool -Recurse -File |
               Select-Object -First 1
        if (-not $src) { Stop-Here "$tool war im Archiv nicht zu finden." }
        Copy-Item $src.FullName (Join-Path $BinDir $tool) -Force
    }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $ffmpeg = Join-Path $BinDir 'ffmpeg.exe'
    Write-Ok "ffmpeg bereit  ->  $ffmpeg"
}

# --- Python fuer den Host ---
# Reihenfolge: bereits mitgeliefert, dann py-Starter, dann python im PATH.
$python = $null
$pythonArgs = @()
$embedded = Join-Path $BinDir 'python\python.exe'
if (Test-Path $embedded) {
    $python = $embedded
} else {
    foreach ($candidate in @('py.exe', 'python3.exe', 'python.exe')) {
        $found = Get-Command $candidate -ErrorAction SilentlyContinue
        if (-not $found) { continue }
        try {
            $probeArgs = if ($candidate -eq 'py.exe') { @('-3', '-c', 'import sys;print(sys.version_info[:2])') }
                         else { @('-c', 'import sys;print(sys.version_info[:2])') }
            $out = & $found.Source @probeArgs 2>$null
            if ($out -match '\((\d+),\s*(\d+)\)' -and
                ([int]$Matches[1] -gt 3 -or ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 8))) {
                $python = $found.Source
                if ($candidate -eq 'py.exe') { $pythonArgs = @('-3') }
                break
            }
        } catch { }
    }
}

if (-not $python) {
    # Die einbettbare Fassung von python.org: ein ZIP ohne Installation,
    # ohne Administratorrechte, ohne Eingriff ins System.
    Write-Warn 'Kein Python gefunden, wird mitgeliefert (rund 10 MB)'
    $tmp = Join-Path $env:TEMP ("ytdl-py-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zip = Join-Path $tmp 'python.zip'
    Get-File 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' $zip
    $target = Join-Path $BinDir 'python'
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Expand-Archive -Path $zip -DestinationPath $target -Force
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $python = Join-Path $target 'python.exe'
    if (-not (Test-Path $python)) { Stop-Here 'Python konnte nicht abgelegt werden.' }
}
$versionText = (& $python @($pythonArgs + '--version') 2>&1) -join ' '
Write-Ok "python  ->  $python  ($versionText)"

# ---------------------------------------------------------- 2. Extension-ID ---

Write-Head '2. Extension-ID'
if (-not (Test-Path $IdFile)) { Stop-Here 'keys\extension_id.txt fehlt - unvollstaendiger Download?' }
$ExtId = (Get-Content $IdFile -Raw).Trim()
Write-Ok $ExtId

# ------------------------------------------------------------ 3. Startskript ---

Write-Head '3. Startskript'

# Native Messaging kann keine .py-Datei starten. Eine .bat als Zwischenstueck
# ist der uebliche Weg; @echo off und die Umleitung halten die Konsole still,
# denn stdout gehoert allein dem Protokoll.
$launcher = Join-Path $Root 'native-host\run_host.bat'
$pythonCall = if ($pythonArgs.Count) { "`"$python`" $($pythonArgs -join ' ')" } else { "`"$python`"" }
@"
@echo off
setlocal
set "PATH=$BinDir;%PATH%"
$pythonCall "$HostPy" %*
"@ | Set-Content -Path $launcher -Encoding ASCII
Write-Ok 'native-host\run_host.bat'

# ---------------------------------------------------------- 4. Host anmelden ---

Write-Head '4. Browser'

$manifestJson = [ordered]@{
    name            = $HostName
    description     = 'Lokaler Downloader mit yt-dlp und ffmpeg'
    path            = $launcher
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtId/")
} | ConvertTo-Json -Depth 4
Set-Content -Path $Manifest -Value $manifestJson -Encoding UTF8
Write-Info "Manifest: $Manifest"

# Unter Windows verweist ein Registrierungsschluessel auf das Manifest.
$browsers = [ordered]@{
    'Chrome'   = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
    'Edge'     = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
    'Brave'    = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
    'Vivaldi'  = 'HKCU:\Software\Vivaldi\NativeMessagingHosts'
    'Chromium' = 'HKCU:\Software\Chromium\NativeMessagingHosts'
}

$count = 0
foreach ($name in $browsers.Keys) {
    $key = Join-Path $browsers[$name] $HostName
    try {
        New-Item -Path $key -Force | Out-Null
        Set-ItemProperty -Path $key -Name '(Default)' -Value $Manifest
        Write-Ok $name
        $count++
    } catch {
        Write-Warn "$name uebersprungen ($($_.Exception.Message))"
    }
}
if ($count -eq 0) { Stop-Here 'Kein Browser konnte eingetragen werden.' }

# ------------------------------------------------------------- 5. Selbsttest ---

Write-Head '5. Selbsttest'
$harness = Join-Path $Root 'tests\harness.py'
$testOut = ''
try {
    $testOut = (& $python @($pythonArgs + $harness + 'ping') 2>&1) -join "`n"
} catch {
    $testOut = $_.Exception.Message
}

if ($testOut -match '"ready":\s*true') {
    $v = if ($testOut -match '"version":\s*"([^"]+)"') { $Matches[1] } else { '?' }
    Write-Ok "Alles bereit - yt-dlp $v"
} else {
    Write-Fail 'Der Host antwortet nicht wie erwartet:'
    $testOut -split "`n" | ForEach-Object { Write-Host "      $_" }
    Write-Host ''
    Read-Host 'Enter zum Schliessen'
    exit 1
}

# ------------------------------------------------------------------ Schluss ---

$extensionPath = Join-Path $Root 'extension'
Write-Host ''
Write-Host 'Noch drei Klicks in Chrome, dann bist du fertig:' -ForegroundColor White
Write-Host ''
Write-Host '  1.  Chrome oeffnen und in die Adresszeile eingeben:'
Write-Host ''
Write-Host '          chrome://extensions' -ForegroundColor Cyan
Write-Host ''
Write-Host '  2.  Rechts oben den Schalter "Entwicklermodus" einschalten'
Write-Host ''
Write-Host '  3.  Links oben auf "Entpackte Erweiterung laden" klicken'
Write-Host '      und diesen Ordner auswaehlen:'
Write-Host ''
Write-Host "          $extensionPath" -ForegroundColor Cyan
Write-Host ''
Write-Host 'Danach eine YouTube-Videoseite neu laden.'
Write-Host ''

# Den Ordner gleich zeigen, damit das Auswaehlen leichter faellt.
try { Start-Process explorer.exe $Root } catch { }

Read-Host 'Enter zum Schliessen'
