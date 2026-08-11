#!/usr/bin/env bash
#
# Schaltet den Begleitdienst für iPhone und iPad ein.
#
# Bewusst ein eigener Schritt: dabei entsteht ein offener Port im WLAN.
# Wer nur am Mac lädt, braucht ihn nicht und soll ihn nicht bekommen.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.yannik.mitschnitt.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVER="$ROOT/native-host/mitschnitt_server.py"
TOKEN_FILE="$HOME/Library/Application Support/Mitschnitt/token"
LOG_DIR="$HOME/Library/Logs/Mitschnitt"
PORT="${MITSCHNITT_PORT:-8787}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo
bold "Mitschnitt — für iPhone und iPad einrichten"
echo

# ------------------------------------------------------------- Voraussetzung ---

if [ ! -f "$ROOT/native-host/run_host.sh" ]; then
  fail "Die Grundeinrichtung fehlt."
  info "Starte zuerst „Installieren (macOS).command“."
  echo
  read -r -p "Enter zum Schließen "
  exit 1
fi

# Denselben Python nehmen, den die Grundeinrichtung ermittelt hat.
PYTHON="$(sed -n 's/^exec "\([^"]*\)".*/\1/p' "$ROOT/native-host/run_host.sh" | head -1)"
[ -x "$PYTHON" ] || PYTHON="$(command -v python3)"
[ -x "$PYTHON" ] || { fail "Kein Python gefunden."; exit 1; }
ok "python3 → $PYTHON"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# ------------------------------------------------------------- Dienst anmelden ---

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$SERVER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MITSCHNITT_PORT</key><string>$PORT</string>
    <key>PATH</key>
    <string>$ROOT/native-host/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.log</string>
</dict>
</plist>
PLISTEOF
ok "LaunchAgent geschrieben"

# Neu laden, falls er schon lief.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null \
  || launchctl load -w "$PLIST" 2>/dev/null \
  || { fail "Der Dienst ließ sich nicht starten."; exit 1; }
ok "Dienst gestartet (läuft ab jetzt nach jedem Anmelden)"

# ------------------------------------------------------------------ Prüfen ---

ADDRESS="$("$PYTHON" - <<'PYEOF'
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("192.0.2.1", 1)); print(s.getsockname()[0]); s.close()
except Exception:
    print("127.0.0.1")
PYEOF
)"

for _ in $(seq 1 20); do
  [ -f "$TOKEN_FILE" ] && break
  sleep 0.5
done
[ -f "$TOKEN_FILE" ] || { fail "Der Dienst hat keinen Schlüssel angelegt."; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"

READY=""
for _ in $(seq 1 20); do
  READY="$(curl -s --max-time 3 -H "X-Token: $TOKEN" \
    "http://127.0.0.1:$PORT/api/ping" 2>/dev/null || true)"
  case "$READY" in *'"ok": true'*) break;; esac
  sleep 0.5
done

case "$READY" in
  *'"ok": true'*) ok "Dienst antwortet" ;;
  *) fail "Der Dienst antwortet nicht. Log: $LOG_DIR/server.log"; exit 1 ;;
esac

PAGE="http://$ADDRESS:$PORT/?t=$TOKEN"

cat <<EOF

$(bold "Weg 1 — Safari (nichts einzurichten)")

  Auf dem iPhone im selben WLAN diese Adresse öffnen:

      $PAGE

  Tipp: „Zum Home-Bildschirm" hinzufügen, dann liegt es wie eine App
  auf dem Bildschirm.

$(bold "Weg 2 — Kurzbefehl im Teilen-Menü")

  Damit lädst du direkt aus der YouTube-App heraus. Vier Aktionen:

  1.  App „Kurzbefehle" → oben rechts auf + → unten auf das Info-Symbol
      und „Im Teilen-Menü anzeigen" einschalten, Typ: URLs

  2.  Aktion „Text" mit genau diesem Inhalt:

          http://$ADDRESS:$PORT/api/grab?t=$TOKEN&height=1080&url=

      Danach die Variable „Kurzbefehlseingabe" ans Ende anhängen.

  3.  Aktion „Inhalte von URL abrufen" mit dem Text davor

  4.  Aktion „In Fotos sichern" (oder „Datei sichern" für die Dateien-App)

  Fertig. In der YouTube-App auf Teilen → dein Kurzbefehl.

$(bold "Gut zu wissen")

  · Der Dienst ist nur in deinem WLAN erreichbar, nicht aus dem Internet.
  · Der Schlüssel in der Adresse ist der Zugang — nicht weitergeben.
  · Für ein anderes Format: height=720 oder statt dessen mode=audio
  · Ausschalten: scripts/iphone-uninstall-macos.sh

EOF

read -r -p "Enter zum Schließen "
