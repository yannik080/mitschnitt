# Entfernt die Anmeldung des Hosts aus der Registrierung.
$ErrorActionPreference = 'SilentlyContinue'
$HostName = 'com.yannik.ytdl_host'
$removed = 0
foreach ($base in @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
  'HKCU:\Software\Vivaldi\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts')) {
  $key = Join-Path $base $HostName
  if (Test-Path $key) { Remove-Item $key -Force; Write-Host "  entfernt: $key"; $removed++ }
}
Write-Host ''
Write-Host "$removed Anmeldung(en) entfernt."
Write-Host 'Die Extension selbst loeschst du unter chrome://extensions.'
Read-Host 'Enter zum Schliessen'
