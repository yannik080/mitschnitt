#!/usr/bin/env bash
#
# Richtet Mitschnitt unter macOS ein.
#
# Fehlt yt-dlp oder ffmpeg, werden eigenständige Fassungen neben den Host
# gelegt — Homebrew ist nicht nötig. Vorhandene Installationen werden
# bevorzugt und nicht angefasst.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_NAME="com.yannik.ytdl_host"
HOST_PY="$ROOT/native-host/ytdl_host.py"
WRAPPER="$ROOT/native-host/run_host.sh"
BIN_DIR="$ROOT/native-host/bin"
ID_FILE="$ROOT/keys/extension_id.txt"

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info()  { printf '    %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

trap 'echo; fail "Abgebrochen. Melde dich mit dieser Ausgabe, dann sehen wir weiter."; echo; read -r -p "Enter zum Schließen "' ERR

echo
bold "Mitschnitt — Einrichtung für macOS"
echo

# ------------------------------------------------------------- 1. Werkzeuge ---

bold "1. Werkzeuge"
mkdir -p "$BIN_DIR"

SEARCH=("$BIN_DIR" /opt/homebrew/bin /usr/local/bin /opt/local/bin "$HOME/.local/bin" /usr/bin /bin)

find_tool() {
  local name="$1" dir
  for dir in "${SEARCH[@]}"; do
    [ -x "$dir/$name" ] && { printf '%s' "$dir/$name"; return 0; }
  done
  return 1
}

download() {   # download <url> <ziel>
  curl --fail --location --silent --show-error --retry 3 --retry-delay 2 \
       --connect-timeout 20 -o "$2" "$1"
}

ARCH="$(uname -m)"   # arm64 oder x86_64

fetch_ytdlp() {
  info "Lade yt-dlp (rund 38 MB) …"
  download "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" \
           "$BIN_DIR/yt-dlp"
  chmod +x "$BIN_DIR/yt-dlp"
  # Die Datei stammt aus curl, trägt also keine Quarantäne — trotzdem
  # sicherheitshalber entfernen, falls sie doch gesetzt wurde.
  xattr -d com.apple.quarantine "$BIN_DIR/yt-dlp" 2>/dev/null || true
}

fetch_ffmpeg() {
  local slice="arm64"
  [ "$ARCH" = "x86_64" ] && slice="amd64"
  local tmp; tmp="$(mktemp -d)"
  local tool                    # sonst überschriebe diese Schleife die äußere
  for tool in ffmpeg ffprobe; do
    info "Lade $tool für $slice …"
    download "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$slice/release/$tool.zip" \
             "$tmp/$tool.zip"
    ( cd "$tmp" && unzip -oq "$tool.zip" )
    mv "$tmp/$tool" "$BIN_DIR/$tool"
    chmod +x "$BIN_DIR/$tool"
    xattr -d com.apple.quarantine "$BIN_DIR/$tool" 2>/dev/null || true
  done
  rm -rf "$tmp"
}

FORCE="${YTDL_FORCE_DOWNLOAD:-0}"

for tool in yt-dlp ffmpeg; do
  if [ "$FORCE" != "1" ] && path="$(find_tool "$tool")"; then
    ok "$tool gefunden  →  $path"
  else
    warn "$tool fehlt, wird geholt"
    if [ "$tool" = "yt-dlp" ]; then fetch_ytdlp; else fetch_ffmpeg; fi
    ok "$tool bereit  →  $(find_tool "$tool")"
  fi
done

# Python: Chrome startet den Host mit minimalem PATH, deshalb ein absoluter Pfad.
PYTHON=""
for candidate in \
    /opt/homebrew/bin/python3 \
    /usr/local/bin/python3 \
    /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
    /usr/bin/python3 \
    "$(command -v python3 2>/dev/null || true)"; do
  [ -x "$candidate" ] || continue
  if "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
    PYTHON="$candidate"; break
  fi
done

if [ -z "$PYTHON" ]; then
  echo
  fail "Kein Python 3.8 oder neuer gefunden."
  info "macOS liefert Python mit den Entwicklerwerkzeugen. Führe aus:"
  info "    xcode-select --install"
  info "und starte diese Einrichtung danach erneut."
  echo
  read -r -p "Enter zum Schließen "
  exit 1
fi
ok "python3  →  $PYTHON  ($("$PYTHON" --version 2>&1))"

# ---------------------------------------------------------- 2. Extension-ID ---

echo
bold "2. Extension-ID"
[ -f "$ID_FILE" ] || { fail "keys/extension_id.txt fehlt — unvollständiger Download?"; exit 1; }
EXT_ID="$(tr -d '[:space:]' < "$ID_FILE")"
ok "$EXT_ID"

# ------------------------------------------------------------- 3. Startskript ---

echo
bold "3. Startskript"
cat > "$WRAPPER" <<WRAP
#!/bin/sh
# Von Chrome gestartet. Chrome übergibt einen minimalen PATH, deshalb hier
# der absolute Pfad zum Python und ein erweiterter PATH.
PATH="$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:\$HOME/.local/bin:/usr/bin:/bin"
export PATH
exec "$PYTHON" "$HOST_PY" "\$@"
WRAP
chmod +x "$WRAPPER" "$HOST_PY"
ok "native-host/run_host.sh"

# --------------------------------------------------------- 4. Host anmelden ---

echo
bold "4. Browser"

declare -a TARGETS=(
  "Chrome|$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "Chrome Beta|$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
  "Chrome Canary|$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "Chromium|$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "Brave|$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "Edge|$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  "Vivaldi|$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
  "Arc|$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
)

MANIFEST=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "Lokaler Downloader mit yt-dlp und ffmpeg",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
JSON
)

INSTALLED=0
for entry in "${TARGETS[@]}"; do
  label="${entry%%|*}"; dir="${entry#*|}"
  [ -d "$(dirname "$dir")" ] || continue
  mkdir -p "$dir"
  printf '%s\n' "$MANIFEST" > "$dir/$HOST_NAME.json"
  ok "$label"
  INSTALLED=$((INSTALLED + 1))
done

if [ "$INSTALLED" -eq 0 ]; then
  fail "Kein unterstützter Browser gefunden. Installiere Chrome und versuche es erneut."
  read -r -p "Enter zum Schließen "
  exit 1
fi

# ------------------------------------------------------------- 5. Selbsttest ---

echo
bold "5. Selbsttest"
TEST_OUT="$("$PYTHON" "$ROOT/tests/harness.py" ping 2>&1 || true)"
if printf '%s' "$TEST_OUT" | grep -q '"ready": true'; then
  SUMMARY="$(printf '%s' "$TEST_OUT" | "$PYTHON" -c '
import json, sys
for line in sys.stdin:
    if line.startswith("<< "):
        d = json.loads(line[3:])
        print("yt-dlp %s, ffmpeg %s" % (d["ytdlp"]["version"], d["ffmpeg"]["version"]))
        break
')"
  ok "Alles bereit — $SUMMARY"
else
  fail "Der Host antwortet nicht wie erwartet:"
  printf '%s\n' "$TEST_OUT" | sed 's/^/      /'
  read -r -p "Enter zum Schließen "
  exit 1
fi

trap - ERR

# ------------------------------------------------------------------ Schluss ---

cat <<EOF

$(bold "Noch drei Klicks in Chrome, dann bist du fertig:")

  1.  Chrome öffnen und in die Adresszeile eingeben:

          chrome://extensions

  2.  Rechts oben den Schalter "Entwicklermodus" einschalten

  3.  Links oben auf "Entpackte Erweiterung laden" klicken
      und diesen Ordner auswählen:

          $ROOT/extension

Danach eine YouTube-Videoseite neu laden. Der Download-Button unter dem
Video gehört ab jetzt dir.

EOF

# Den Ordner gleich im Finder zeigen, damit das Auswählen leichter fällt.
open "$ROOT" >/dev/null 2>&1 || true

read -r -p "Enter zum Schließen "
