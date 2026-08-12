# Auf dem iPhone — ohne Mac

Es geht auch eigenständig, ganz ohne Rechner im Hintergrund. Der Weg führt
über **a-Shell**, eine kostenlose Terminal-App mit eingebautem Python. Darin
läuft dasselbe yt-dlp wie auf dem Mac, und es gibt sogar ein passendes FFmpeg.

> **Ehrlicher Hinweis vorweg:** Diese Anleitung ist geprüft, was die Bausteine
> angeht — a-Shell liegt im App Store, die FFmpeg-Dateien sind abrufbar. Auf
> einem echten iPhone durchgespielt habe ich sie **nicht**, weil hier keines
> zur Verfügung steht. Wenn ein Schritt klemmt, steht unten, woran es liegen
> dürfte.

---

## Einmal einrichten (rund 10 Minuten)

### 1. a-Shell installieren

[a-Shell im App Store](https://apps.apple.com/de/app/a-shell/id1473805438) —
kostenlos, ab iOS 14. Nicht „a-Shell mini" nehmen, der fehlt das Nötige.

### 2. Diese vier Zeilen in a-Shell eingeben

App öffnen, tippen (oder von hier kopieren und einfügen):

```sh
mkdir -p ~/Documents/bin && cd ~/Documents/bin
curl -L -o ffmpeg.wasm  https://github.com/holzschu/a-Shell-commands/releases/download/0.1/ffmpeg.wasm
curl -L -o ffprobe.wasm https://github.com/holzschu/a-Shell-commands/releases/download/0.1/ffprobe.wasm
pip install -U yt-dlp
```

Das lädt zweimal rund 18 MB und danach yt-dlp. Einmalig.

### 3. Prüfen, ob es sitzt

```sh
yt-dlp --version
ffmpeg -version
```

Kommen beide mit einer Versionsnummer zurück, ist alles da.

---

## Ein Video laden

```sh
cd ~/Documents
yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]/b" --merge-output-format mp4 \
       -o "%(title).150B.%(ext)s" "HIER-DIE-ADRESSE"
```

Die fertige Datei liegt danach in **Dateien → Auf meinem iPhone → a-Shell**.
Von dort: antippen → Teilen → **Video sichern**, und es landet in Fotos.

Nur den Ton:

```sh
yt-dlp -x --audio-format mp3 --audio-quality 0 -o "%(title).150B.%(ext)s" "ADRESSE"
```

---

## Bequemer: ein Kurzbefehl im Teilen-Menü

Damit lädst du direkt aus der YouTube-App, ohne Tippen.

**Zuerst ein Skript anlegen.** In a-Shell:

```sh
cat > ~/Documents/laden.sh <<'ENDE'
#!/bin/sh
cd ~/Documents
yt-dlp -f "bv*[height<=1080]+ba/b[height<=1080]/b" \
       --merge-output-format mp4 \
       -o "%(title).150B.%(ext)s" "$1"
ENDE
chmod +x ~/Documents/laden.sh
```

**Dann der Kurzbefehl.** App „Kurzbefehle" → neuer Kurzbefehl:

1. Unten aufs Info-Symbol → **Im Teilen-Menü anzeigen** einschalten, Typ **URLs**
2. Aktion **Text**: `sh ~/Documents/laden.sh "` — dann die Variable
   **Kurzbefehlseingabe** anhängen — dann `"` als Abschluss
3. Aktion **Execute Command** (aus a-Shell) mit diesem Text als Befehl

Teilen in der YouTube-App → dein Kurzbefehl. Die Datei erscheint danach in
der Dateien-App unter a-Shell.

---

## Wenn etwas klemmt

**„ffmpeg not found" oder es wird nichts zusammengeführt.**
Der wahrscheinlichste Stolperstein: yt-dlp startet FFmpeg als eigenen Prozess,
und iOS erlaubt das nicht so wie auf einem Rechner. Zwei Auswege:

*Sag yt-dlp, wo es liegt:*

```sh
yt-dlp --ffmpeg-location ~/Documents/bin -f "bv*+ba/b" "ADRESSE"
```

*Oder umgehe die Zusammenführung ganz.* Es gibt bei YouTube ein Format, das
Bild und Ton bereits in einer Datei hat — dafür braucht es kein FFmpeg:

```sh
yt-dlp -f 18 -o "%(title).150B.%(ext)s" "ADRESSE"
```

Das ist allerdings auf **360p** begrenzt. Mehr geht ohne FFmpeg nicht, weil
YouTube höhere Auflösungen grundsätzlich in getrennten Spuren ausliefert.

**„pip: command not found".** In a-Shell heißt es manchmal `pip3`. Sonst:
`python3 -m pip install -U yt-dlp`.

**Es bricht mitten im Download ab.** Denselben Befehl noch einmal absetzen —
yt-dlp setzt an der abgerissenen Stelle fort, genau wie am Mac.

**yt-dlp ist zu alt, YouTube hat sich geändert.** `pip install -U yt-dlp`.

---

## Was dieser Weg nicht ist

Er ist **kein Produkt zum Verteilen**. Jeder, der ihn nutzen will, installiert
a-Shell selbst und führt die Einrichtung selbst aus. Eine iPhone-App, die das
alles mitbringt, kann es nicht geben: Apple lässt solche Apps nicht in den
App Store, und ohne App Store gibt es auf iOS keinen Verbreitungsweg.

Es ist also eine **Anleitung**, keine Software — dafür eine, die ohne fremden
Server und ohne zweiten Rechner auskommt.
