#!/usr/bin/env bash
# Entfernt die Anmeldung des Hosts. Die Extension selbst wird in
# chrome://extensions gelöscht, heruntergeladene Dateien bleiben liegen.
set -euo pipefail
HOST_NAME="com.yannik.ytdl_host"
REMOVED=0
for dir in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
do
  if [ -f "$dir/$HOST_NAME.json" ]; then
    rm "$dir/$HOST_NAME.json"; printf '  entfernt: %s\n' "$dir"; REMOVED=$((REMOVED+1))
  fi
done
printf '\n%d Anmeldung(en) entfernt.\n' "$REMOVED"
printf 'Die Extension selbst löschst du unter chrome://extensions.\n'
