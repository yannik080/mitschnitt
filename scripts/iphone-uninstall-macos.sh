#!/usr/bin/env bash
# Schaltet den Begleitdienst wieder ab und schließt damit den Port.
set -euo pipefail
LABEL="com.yannik.mitschnitt.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
[ -f "$PLIST" ] && rm "$PLIST" && echo "  LaunchAgent entfernt"
pkill -f mitschnitt_server.py 2>/dev/null || true
echo "  Dienst gestoppt. Der Port ist wieder zu."
echo "  Der Schlüssel bleibt liegen; zum Erneuern löschen:"
echo "    ~/Library/Application Support/Mitschnitt/token"
