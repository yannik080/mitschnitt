#!/usr/bin/env bash
#
# Baut die Archive, die auf GitHub unter „Releases" liegen.
#
# Die Archive bleiben klein: yt-dlp und ffmpeg holt die Einrichtung selbst,
# damit niemand eine veraltete Fassung mitgeliefert bekommt.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist"
VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/extension/manifest.json'))['version'])")"

rm -rf "$OUT"
mkdir -p "$OUT"

stage() {   # stage <system>
  local system="$1"
  local dir="$OUT/stage-$system/Mitschnitt"
  mkdir -p "$dir"

  cp -R "$ROOT/extension" "$dir/"
  mkdir -p "$dir/native-host" "$dir/keys" "$dir/tests" "$dir/scripts"
  cp "$ROOT/native-host/ytdl_host.py" "$dir/native-host/"
  # Nur der öffentliche Teil: der private Schlüssel bleibt hier.
  cp "$ROOT/keys/extension_id.txt" "$ROOT/keys/manifest_key.txt" "$dir/keys/"
  cp "$ROOT/tests/harness.py" "$dir/tests/"
  cp "$ROOT/README.md" "$dir/"
  cp "$ROOT/LICENSE" "$dir/" 2>/dev/null || true

  if [ "$system" = "macos" ]; then
    cp "$ROOT/scripts/install-macos.sh" "$ROOT/scripts/uninstall-macos.sh" "$dir/scripts/"
    cp "$ROOT/Installieren (macOS).command" "$dir/"
    chmod +x "$dir/Installieren (macOS).command" "$dir/scripts/"*.sh
  else
    cp "$ROOT/scripts/install-windows.ps1" "$ROOT/scripts/uninstall-windows.ps1" "$dir/scripts/"
    cp "$ROOT/Installieren (Windows).bat" "$dir/"
  fi

  write_readme "$system" "$dir/ANLEITUNG.txt"
  printf '%s' "$dir"
}

write_readme() {   # write_readme <system> <ziel>
  local system="$1" target="$2"
  local starter="Installieren (macOS).command"
  local hinweis="Beim ersten Mal meldet macOS womöglich „nicht geöffnet werden,
  weil es von einem nicht verifizierten Entwickler stammt\".
  Dann: Rechtsklick auf die Datei -> Öffnen -> im Dialog auf Öffnen."
  if [ "$system" = "windows" ]; then
    starter="Installieren (Windows).bat"
    hinweis="Beim ersten Mal meldet Windows womöglich „Der Computer wurde
  geschützt\". Dann: auf „Weitere Informationen\" -> „Trotzdem ausführen\"."
  fi

  cat > "$target" <<EOF
Mitschnitt
==========

Ersetzt den Download-Button unter Videos durch einen eigenen. Der
Download läuft auf deinem Rechner, nichts geht über einen fremden
Server.


SO GEHT ES
----------

Schritt 1 — Einrichtung starten

  Doppelklick auf:  $starter

  $hinweis

  Es öffnet sich ein Fenster, das die benötigten Werkzeuge holt
  (beim ersten Mal ein paar hundert MB) und alles einrichtet.


Schritt 2 — Erweiterung in Chrome laden

  1. Chrome öffnen, in die Adresszeile eingeben:  chrome://extensions
  2. Rechts oben "Entwicklermodus" einschalten
  3. Links oben "Entpackte Erweiterung laden" anklicken
  4. Den Ordner "extension" aus diesem Verzeichnis auswählen


Schritt 3 — Fertig

  Videoseite neu laden. Unter dem Video steht jetzt dein eigener
  Download-Button.


WICHTIG
-------

Diesen Ordner nicht verschieben oder löschen. Chrome merkt sich den
Ort. Wenn du ihn doch verschiebst, starte die Einrichtung erneut.


WOFÜR DAS GEDACHT IST
---------------------

Für eigene Videos, frei lizenzierte Inhalte und Material, für das du
die Rechte oder eine Erlaubnis hast.

Die Nutzungsbedingungen von Videoplattformen untersagen das Herunter-
laden in aller Regel. Nach der Rechtsprechung des OLG Hamburg (Urteil
vom 21.11.2024, Az. 5 U 54/23) ist die Umgehung technischer Schutz-
maßnahmen zudem nicht durch die Privatkopieschranke gedeckt. Was du
mit diesem Werkzeug machst, liegt in deiner Verantwortung.


WENN ETWAS NICHT GEHT
---------------------

Klick auf das Symbol in der Symbolleiste. Dort steht, was fehlt.

Version $VERSION
EOF
}

echo "Baue Version $VERSION"

for system in macos windows; do
  dir="$(stage "$system")"
  # Ohne Version im Namen, damit der Link
  #   .../releases/latest/download/Mitschnitt-macOS.zip
  # dauerhaft funktioniert. Die Version steht im Release selbst.
  label="macOS"
  [ "$system" = "windows" ] && label="Windows"
  name="Mitschnitt-$label.zip"
  ( cd "$OUT/stage-$system" && zip -qr "$OUT/$name" "Mitschnitt" -x '*.DS_Store' )
  size="$(du -h "$OUT/$name" | cut -f1 | tr -d ' ')"
  echo "  $name  ($size)"
  rm -rf "$OUT/stage-$system"
done

echo
echo "Fertig in $OUT"
