#!/usr/bin/env python3
"""
Native Messaging Host für die YouTube-Downloader-Extension.

Spricht Chromes Native-Messaging-Protokoll über stdin/stdout
(4 Byte Länge little-endian + UTF-8-JSON) und führt lokal yt-dlp
und ffmpeg aus.

stdout ist ausschließlich dem Protokoll vorbehalten — jede Diagnose
geht ins Logfile unter ~/Library/Logs/YouTubeDownloader/host.log.
"""

import json
import os
import re
import shlex
import signal
import struct
import subprocess
import tempfile
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HOST_VERSION = "1.1.0"

IS_WINDOWS = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"

if IS_WINDOWS:
    # Ohne das schreibt Windows jedes \n als \r\n — das zerstört sowohl
    # den 4-Byte-Längenkopf als auch das JSON. Klassischer Stolperstein
    # bei Native Messaging.
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

# Feldtrenner im yt-dlp-Progress-Template (ASCII Unit Separator).
SEP = "\x1f"

# ---------------------------------------------------------------- Logging ---

def _log_dir():
    if IS_WINDOWS:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "YouTubeDownloader" / "Logs"
    if IS_MAC:
        return Path.home() / "Library" / "Logs" / "YouTubeDownloader"
    return Path.home() / ".local" / "state" / "youtube-downloader"


LOG_DIR = _log_dir()
LOG_FILE = LOG_DIR / "host.log"
_log_lock = threading.Lock()


def log(*parts):
    line = "%s  %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"),
                         " ".join(str(p) for p in parts))
    try:
        with _log_lock:
            LOG_DIR.mkdir(parents=True, exist_ok=True)
            if LOG_FILE.exists() and LOG_FILE.stat().st_size > 2_000_000:
                LOG_FILE.rename(LOG_FILE.with_suffix(".log.1"))
            with LOG_FILE.open("a", encoding="utf-8") as fh:
                fh.write(line)
    except Exception:
        pass


# --------------------------------------------------------------- Protokoll ---

_stdout_lock = threading.Lock()
_stdin = sys.stdin.buffer
_stdout = sys.stdout.buffer

# Chrome akzeptiert höchstens 1 MB pro Nachricht vom Host.
MAX_MESSAGE_BYTES = 1024 * 1024


def read_message():
    header = _stdin.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    if length == 0 or length > 64 * 1024 * 1024:
        raise ValueError("Ungültige Nachrichtenlänge: %d" % length)
    payload = _stdin.read(length)
    if len(payload) < length:
        return None
    return json.loads(payload.decode("utf-8"))


def send(message):
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    if len(data) > MAX_MESSAGE_BYTES:
        message = {"type": "error", "id": message.get("id"),
                   "message": "Antwort zu groß für Native Messaging."}
        data = json.dumps(message).encode("utf-8")
    with _stdout_lock:
        try:
            _stdout.write(struct.pack("<I", len(data)))
            _stdout.write(data)
            _stdout.flush()
        except (BrokenPipeError, ValueError):
            os._exit(0)


# ------------------------------------------------------- Binaries auffinden ---

# Chrome startet Native Hosts mit einem minimalen PATH — unter macOS fehlt
# Homebrew darin, unter Windows praktisch alles. Deshalb wird gesucht statt
# sich auf PATH zu verlassen. „bin" neben dem Host kommt zuerst: dorthin
# legt der Installer mitgelieferte Werkzeuge.
HOST_DIR = Path(__file__).resolve().parent
BUNDLED_DIR = HOST_DIR / "bin"

if IS_WINDOWS:
    SEARCH_PATHS = [
        str(BUNDLED_DIR),
        str(Path(os.environ.get("LOCALAPPDATA", Path.home())) / "YouTubeDownloader" / "bin"),
        str(Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Microsoft" / "WinGet" / "Links"),
        str(Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "ffmpeg" / "bin"),
        "C:\\ffmpeg\\bin",
    ] + [part for part in os.environ.get("PATH", "").split(os.pathsep) if part]
    BINARY_SUFFIX = ".exe"
else:
    SEARCH_PATHS = [
        str(BUNDLED_DIR),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        str(Path.home() / ".local" / "bin"),
        str(Path.home() / "bin"),
        "/usr/bin",
        "/bin",
    ]
    BINARY_SUFFIX = ""


def find_binary(name):
    override = os.environ.get("YTDL_HOST_%s" % name.upper().replace("-", "_"))
    if override and os.path.isfile(override):
        return override
    candidates = [name + BINARY_SUFFIX] if BINARY_SUFFIX else [name]
    if IS_WINDOWS and name == "yt-dlp":
        candidates.append("yt-dlp.exe")
    for directory in SEARCH_PATHS:
        for candidate_name in candidates:
            candidate = os.path.join(directory, candidate_name)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
    return None


YTDLP = find_binary("yt-dlp")
FFMPEG = find_binary("ffmpeg")
FFPROBE = find_binary("ffprobe")


def _quiet_flags():
    return {"creationflags": 0x08000000} if IS_WINDOWS else {}


def _spawn_flags():
    """Eigene Prozessgruppe, damit der Abbruch auch die Kinder erwischt —
    und unter Windows ohne aufpoppendes Konsolenfenster."""
    if IS_WINDOWS:
        return {"creationflags": 0x00000200 | 0x08000000}   # NEW_PROCESS_GROUP | NO_WINDOW
    return {"start_new_session": True}


def child_env():
    env = os.environ.copy()
    env["PATH"] = os.pathsep.join(SEARCH_PATHS + [env.get("PATH", "")])
    return env


# --------------------------------------------------------------- Validierung ---

URL_ALLOWED = re.compile(
    r"^https?://(www\.|m\.|music\.)?(youtube\.com|youtube-nocookie\.com)/"
    r"|^https?://youtu\.be/",
    re.IGNORECASE,
)

HEIGHTS = {0, 144, 240, 360, 480, 720, 1080, 1440, 2160, 4320}
AUDIO_FORMATS = {"mp3", "m4a", "opus", "flac", "wav", "vorbis", "aac", "best"}
CONTAINERS = {"mp4", "mkv", "webm"}
BROWSERS = {"", "chrome", "brave", "chromium", "edge", "firefox", "safari",
            "opera", "vivaldi"}
SUBLANGS_RE = re.compile(r"^[A-Za-z0-9,\-\.\*]{1,120}$")
RATE_RE = re.compile(r"^\d+(\.\d+)?[KMG]?$")


def validate_url(url):
    if not isinstance(url, str) or len(url) > 2048:
        raise ValueError("Ungültige URL.")
    if not URL_ALLOWED.match(url.strip()):
        raise ValueError("Nur YouTube-URLs sind erlaubt.")
    return url.strip()


def resolve_output_dir(raw):
    home = Path.home().resolve()
    if not raw:
        target = home / "Downloads" / "YouTube"
    else:
        target = Path(os.path.expanduser(str(raw)))
        if not target.is_absolute():
            target = home / target
    target = Path(os.path.normpath(str(target)))
    try:
        target.relative_to(home)
    except ValueError:
        raise ValueError("Zielordner muss innerhalb des Benutzerordners liegen.")
    target.mkdir(parents=True, exist_ok=True)
    return target


VIDEO_ID_IN_NAME = re.compile(r"\[([A-Za-z0-9_-]{11})\]")


def partial_files(out_dir):
    """Angefangene Downloads im Temp-Verzeichnis, gruppiert nach Video-ID."""
    temp_dir = Path(out_dir) / ".incomplete"
    if not temp_dir.is_dir():
        return []
    groups = {}
    for entry in temp_dir.iterdir():
        if not entry.is_file() or not entry.name.endswith(".part"):
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        match = VIDEO_ID_IN_NAME.search(entry.name)
        key = match.group(1) if match else entry.name
        group = groups.setdefault(key, {
            "videoId": match.group(1) if match else None,
            "name": VIDEO_ID_IN_NAME.sub("", entry.name)
                    .replace(".part", "").strip(),
            "bytes": 0,
            "files": 0,
            "modified": 0,
        })
        group["bytes"] += stat.st_size
        group["files"] += 1
        group["modified"] = max(group["modified"], int(stat.st_mtime))
    return sorted(groups.values(), key=lambda g: g["modified"], reverse=True)


def partial_bytes(out_dir, video_id=None):
    total = 0
    for group in partial_files(out_dir):
        if video_id and group.get("videoId") != video_id:
            continue
        total += group["bytes"]
    return total or None


def discard_partials(out_dir, video_id=None):
    """Löscht angefangene Downloads — alle oder die eines Videos."""
    temp_dir = Path(out_dir) / ".incomplete"
    if not temp_dir.is_dir():
        return 0
    removed = 0
    for entry in temp_dir.iterdir():
        if not entry.is_file():
            continue
        if not (entry.name.endswith(".part") or entry.name.endswith(".ytdl")):
            continue
        if video_id:
            match = VIDEO_ID_IN_NAME.search(entry.name)
            if not match or match.group(1) != video_id:
                continue
        try:
            entry.unlink()
            removed += 1
        except OSError:
            pass
    try:
        if not any(temp_dir.iterdir()):
            temp_dir.rmdir()
    except OSError:
        pass
    return removed


def clean_template(raw):
    default = "%(title)s [%(id)s].%(ext)s"
    if not raw or not isinstance(raw, str):
        return default
    if ".." in raw or raw.startswith("/") or "\x00" in raw or len(raw) > 200:
        return default
    return raw


# --------------------------------------------------------- yt-dlp-Argumente ---

def build_format_selector(opts):
    """Übersetzt die Auswahl der Oberfläche in einen yt-dlp-Format-Selektor."""
    height = opts.get("height", 0)
    if height not in HEIGHTS:
        height = 0
    limit = "[height<=%d]" % height if height else ""

    if opts.get("forceH264"):
        # QuickTime/Final Cut spielen zuverlässig nur avc1 + mp4a ab.
        return (
            "bv*[vcodec^=avc1]{h}+ba[acodec^=mp4a]/"
            "bv*[vcodec^=avc1]{h}+ba/"
            "b[vcodec^=avc1]{h}/"
            "bv*{h}+ba/b{h}/bv*+ba/b"
        ).format(h=limit)
    return ("bv*{h}+ba/b{h}/bv*+ba/b").format(h=limit)


def build_command(url, opts, out_dir):
    container = opts.get("container", "mp4")
    if container not in CONTAINERS:
        container = "mp4"
    template = clean_template(opts.get("filenameTemplate"))

    cmd = [
        YTDLP,
        "--newline",
        "--no-simulate",          # --print aktiviert sonst --simulate
        "--progress",
        "--no-colors",
        "--no-warnings",
        "--ignore-config",        # Nutzer-Config darf uns nicht überstimmen
        "--no-update",
        "--no-mtime",
        "--continue",             # angefangene Datei fortsetzen statt neu laden
        "--retries", "30",
        "--fragment-retries", "30",
        "--retry-sleep", "http:exp=1:60",
        "--retry-sleep", "fragment:exp=1:60",
        "--socket-timeout", "30",
        "--trim-filenames", "180",
        "--paths", "home:%s" % out_dir,
        "--paths", "temp:%s" % (out_dir / ".incomplete"),
        "--output", template,
        "--progress-template",
        "download:@@P@@" + SEP.join([
            "%(progress.status)s",
            "%(progress.downloaded_bytes)s",
            "%(progress.total_bytes)s",
            "%(progress.total_bytes_estimate)s",
            "%(progress.speed)s",
            "%(progress.eta)s",
            "%(progress.fragment_index)s",
            "%(progress.fragment_count)s",
        ]),
        "--progress-template",
        "postprocess:@@PP@@%(progress.postprocessor)s",
        "--print", "video:@@META@@%(title)j",
        "--print", "after_move:@@FILE@@%(filepath)s",
    ]

    if FFMPEG:
        cmd += ["--ffmpeg-location", os.path.dirname(FFMPEG)]

    if opts.get("playlist"):
        cmd.append("--yes-playlist")
    else:
        cmd.append("--no-playlist")

    frags = opts.get("concurrentFragments")
    if isinstance(frags, int) and 1 <= frags <= 16:
        cmd += ["--concurrent-fragments", str(frags)]

    rate = str(opts.get("rateLimit") or "")
    if rate and RATE_RE.match(rate):
        cmd += ["--limit-rate", rate]

    browser = str(opts.get("cookiesFromBrowser") or "")
    if browser and browser in BROWSERS:
        cmd += ["--cookies-from-browser", browser]

    if opts.get("mode") == "audio":
        audio_format = opts.get("audioFormat", "mp3")
        if audio_format not in AUDIO_FORMATS:
            audio_format = "mp3"
        cmd += ["--extract-audio",
                "--audio-format", audio_format,
                "--audio-quality", "0",
                "--format", "ba/b"]
        if opts.get("thumbnail", True):
            cmd.append("--embed-thumbnail")
        if opts.get("metadata", True):
            cmd.append("--embed-metadata")
    else:
        cmd += ["--format", build_format_selector(opts),
                "--merge-output-format", container]
        if opts.get("metadata", True):
            cmd.append("--embed-metadata")
        if opts.get("chapters", True):
            cmd.append("--embed-chapters")
        if opts.get("thumbnail"):
            cmd.append("--embed-thumbnail")
        if opts.get("subs"):
            langs = str(opts.get("subLangs") or "de,en")
            if not SUBLANGS_RE.match(langs):
                langs = "de,en"
            cmd += ["--write-subs", "--write-auto-subs",
                    "--sub-langs", langs, "--embed-subs",
                    "--compat-options", "no-keep-subs"]

    if opts.get("sponsorblock"):
        cmd += ["--sponsorblock-remove",
                "sponsor,selfpromo,interaction,intro,outro,music_offtopic"]

    cmd.append("--")
    cmd.append(url)
    return cmd


# ------------------------------------------------------------ Fehlertexte ---

ERROR_HINTS = [
    (r"Sign in to confirm (your age|you'?re not a bot)",
     "YouTube verlangt eine Anmeldung. Aktiviere in den Einstellungen "
     "„Cookies aus Chrome verwenden“."),
    (r"This video is private",
     "Das Video ist privat."),
    (r"Video unavailable",
     "Das Video ist nicht verfügbar (gelöscht oder regional gesperrt)."),
    (r"members-only|join this channel",
     "Das Video ist nur für Kanalmitglieder verfügbar."),
    (r"HTTP Error 429|Too Many Requests",
     "YouTube drosselt die Anfragen. Warte ein paar Minuten."),
    (r"Requested format is not available",
     "Diese Qualität gibt es für das Video nicht. Wähle eine niedrigere."),
    (r"ffmpeg (is )?not (found|installed)|ffmpeg not found",
     "ffmpeg wurde nicht gefunden. Installiere es mit: brew install ffmpeg"),
    (r"Unable to (extract|download) .*player",
     "yt-dlp ist zu alt für YouTubes aktuelle Seite. "
     "Aktualisiere mit: brew upgrade yt-dlp"),
    (r"Permission denied",
     "Kein Schreibrecht im Zielordner."),
    (r"No space left on device",
     "Auf dem Laufwerk ist kein Platz mehr."),
    (r"could not (find|open) .*cookies|Could not copy Chrome cookie database",
     "Chrome-Cookies konnten nicht gelesen werden. Schließe Chrome oder "
     "deaktiviere die Cookie-Option."),
]


# Fehler, nach denen ein erneuter Anlauf an derselben Stelle weitermacht.
RESUMABLE_PATTERNS = [
    r"urlopen error", r"timed out", r"timeout",
    r"Connection (reset|refused|aborted|broken)",
    r"Temporary failure in name resolution",
    r"Network is unreachable", r"No route to host",
    r"Remote end closed connection",
    r"HTTP Error 5\d\d",
    r"unable to download video data",
    r"Unable to download (webpage|API page|JSON metadata)",
    r"fragment.*not found, unable to continue",
    r"Interrupted by user",
    r"\[Errno 5[0-9]\]",
]


def is_resumable(stderr_text):
    return any(re.search(p, stderr_text, re.IGNORECASE) for p in RESUMABLE_PATTERNS)


def humanize_error(stderr_text, returncode):
    for pattern, hint in ERROR_HINTS:
        if re.search(pattern, stderr_text, re.IGNORECASE):
            return hint
    for line in reversed(stderr_text.strip().splitlines()):
        line = line.strip()
        if line.startswith("ERROR:"):
            return line[6:].strip()
        if line and not line.startswith("WARNING:"):
            return line
    return "yt-dlp wurde mit Code %s beendet." % returncode


# -------------------------------------------------------------- Jobs ---

class JobRegistry:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs = {}
        self._cancelled = set()

    def add(self, job_id, process):
        with self._lock:
            self._jobs[job_id] = process
            self._cancelled.discard(job_id)

    def remove(self, job_id):
        with self._lock:
            self._jobs.pop(job_id, None)

    def was_cancelled(self, job_id):
        """Der Exitcode taugt nicht als Anzeiger: Windows meldet nach einem
        taskkill etwas anderes als POSIX nach SIGTERM. Wer abgebrochen hat,
        wissen wir aber selbst."""
        with self._lock:
            return job_id in self._cancelled

    def clear_cancelled(self, job_id):
        with self._lock:
            self._cancelled.discard(job_id)

    def cancel(self, job_id):
        with self._lock:
            process = self._jobs.get(job_id)
            if process:
                self._cancelled.add(job_id)
        if not process:
            return False
        try:
            if IS_WINDOWS:
                # yt-dlp startet ffmpeg als Kindprozess; ohne /T bliebe der
                # am Leben und die Datei belegt.
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)],
                               capture_output=True, timeout=15,
                               creationflags=0x08000000)   # kein Konsolenfenster
            else:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except Exception:
            try:
                process.terminate()
            except Exception:
                return False
        return True

    def cancel_all(self):
        with self._lock:
            ids = list(self._jobs)
        for job_id in ids:
            self.cancel(job_id)

    def count(self):
        with self._lock:
            return len(self._jobs)


JOBS = JobRegistry()


def _num(raw):
    if raw in (None, "", "NA", "None"):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return None if value != value else value  # NaN aussortieren


def parse_progress(payload):
    parts = payload.split(SEP)
    while len(parts) < 8:
        parts.append("")
    status, downloaded, total, estimate, speed, eta, frag_i, frag_n = parts[:8]
    total_bytes = _num(total) or _num(estimate)
    downloaded_bytes = _num(downloaded)

    percent = None
    if total_bytes and downloaded_bytes is not None and total_bytes > 0:
        percent = max(0.0, min(100.0, downloaded_bytes / total_bytes * 100.0))
    elif _num(frag_n) and _num(frag_i) is not None:
        percent = max(0.0, min(100.0, _num(frag_i) / _num(frag_n) * 100.0))

    return {
        "status": status or "downloading",
        "downloaded": downloaded_bytes,
        "total": total_bytes,
        "speed": _num(speed),
        "eta": _num(eta),
        "percent": percent,
    }


POSTPROCESSOR_LABELS = {
    "Merger": "Video und Ton zusammenführen",
    "ExtractAudio": "Audio extrahieren",
    "FFmpegExtractAudio": "Audio extrahieren",
    "VideoConvertor": "Konvertieren",
    "FFmpegVideoConvertor": "Konvertieren",
    "FFmpegVideoRemuxer": "Umpacken",
    "EmbedThumbnail": "Cover einbetten",
    "FFmpegThumbnailsConvertor": "Cover vorbereiten",
    "FFmpegMetadata": "Metadaten schreiben",
    "FFmpegEmbedSubtitle": "Untertitel einbetten",
    "SponsorBlock": "SponsorBlock prüfen",
    "ModifyChapters": "Segmente entfernen",
    "MoveFiles": "Datei ablegen",
}


def run_download(job_id, url, opts):
    started = time.time()
    try:
        url = validate_url(url)
        out_dir = resolve_output_dir(opts.get("outputDir"))
    except Exception as exc:
        send({"type": "error", "id": job_id, "message": str(exc)})
        return

    if not YTDLP:
        send({"type": "error", "id": job_id,
              "message": "yt-dlp wurde nicht gefunden. "
                         "Installiere es mit: brew install yt-dlp"})
        return

    cmd = build_command(url, opts, out_dir)
    log("JOB", job_id, "→", " ".join(shlex.quote(c) for c in cmd))

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=child_env(),
            cwd=str(out_dir),
            bufsize=1,
            universal_newlines=True,
            encoding="utf-8",
            errors="replace",
            **_spawn_flags(),
        )
    except Exception as exc:
        send({"type": "error", "id": job_id,
              "message": "yt-dlp konnte nicht gestartet werden: %s" % exc})
        return

    JOBS.add(job_id, process)
    stderr_lines = []

    def drain_stderr():
        for line in process.stderr:
            stderr_lines.append(line.rstrip())
            if len(stderr_lines) > 60:
                del stderr_lines[0]
            log("JOB", job_id, "stderr:", line.rstrip())

    err_thread = threading.Thread(target=drain_stderr, daemon=True)
    err_thread.start()

    final_path = None
    title = None
    last_emit = 0.0
    last_percent = -1.0

    send({"type": "started", "id": job_id, "outputDir": str(out_dir)})

    try:
        for raw in process.stdout:
            line = raw.rstrip("\n")
            if not line:
                continue

            if line.startswith("@@P@@"):
                info = parse_progress(line[5:])
                now = time.time()
                percent = info.get("percent")
                changed = percent is None or abs((percent or 0) - last_percent) >= 0.4
                # Höchstens 8 Updates/s an die Extension.
                if now - last_emit >= 0.12 and (changed or now - last_emit > 1.0):
                    last_emit = now
                    if percent is not None:
                        last_percent = percent
                    send({"type": "progress", "id": job_id, **info})

            elif line.startswith("@@PP@@"):
                name = line[6:].strip()
                send({"type": "stage", "id": job_id,
                      "stage": POSTPROCESSOR_LABELS.get(name, name or "Verarbeiten"),
                      "raw": name})

            elif line.startswith("@@META@@"):
                try:
                    title = json.loads(line[8:])
                except Exception:
                    title = line[8:].strip('"')
                send({"type": "meta", "id": job_id, "title": title})

            elif line.startswith("@@FILE@@"):
                final_path = line[8:].strip()

            elif "Merging formats into" in line:
                send({"type": "stage", "id": job_id,
                      "stage": "Video und Ton zusammenführen", "raw": "Merger"})
            else:
                log("JOB", job_id, "stdout:", line)
    except Exception:
        log("JOB", job_id, "Leseschleife:", traceback.format_exc())

    returncode = process.wait()
    err_thread.join(timeout=2)
    cancelled_by_user = JOBS.was_cancelled(job_id)
    JOBS.remove(job_id)
    JOBS.clear_cancelled(job_id)
    stderr_text = "\n".join(stderr_lines)

    # Leeres Temp-Verzeichnis entfernen, bevor der Abschluss gemeldet wird.
    try:
        temp_dir = out_dir / ".incomplete"
        if temp_dir.is_dir() and not any(temp_dir.iterdir()):
            temp_dir.rmdir()
    except Exception:
        pass

    if returncode == 0 and final_path and os.path.exists(final_path):
        size = os.path.getsize(final_path)
        send({"type": "done", "id": job_id,
              "path": final_path,
              "filename": os.path.basename(final_path),
              "title": title,
              "size": size,
              "seconds": round(time.time() - started, 1)})
        log("JOB", job_id, "fertig:", final_path, size, "Bytes")
    elif cancelled_by_user or returncode in (-signal.SIGTERM, -signal.SIGKILL, 130, 143):
        send({"type": "cancelled", "id": job_id,
              "partialBytes": partial_bytes(out_dir)})
        log("JOB", job_id, "abgebrochen")
    elif returncode == 0 and not final_path:
        send({"type": "error", "id": job_id,
              "message": "Download beendet, aber keine Datei gefunden. "
                         "Details im Log."})
        log("JOB", job_id, "kein Dateipfad; stderr:", stderr_text[-500:])
    else:
        resumable = is_resumable(stderr_text)
        message = humanize_error(stderr_text, returncode)
        if resumable:
            message = ("Verbindung unterbrochen. Der Fortschritt ist gesichert — "
                       "beim nächsten Versuch geht es an derselben Stelle weiter.")
        send({"type": "error", "id": job_id,
              "message": message,
              "resumable": resumable,
              "partialBytes": partial_bytes(out_dir),
              "detail": stderr_text[-1500:]})
        log("JOB", job_id, "Fehler rc=%s resumable=%s" % (returncode, resumable))



# ------------------------------------------------------------------ Probe ---

def _selected_format_ids(info_path, selector):
    """
    Fragt yt-dlp, welche Formate es für diesen Selektor nähme — offline aus
    der bereits geholten Info. Nur so stimmt die Größenangabe: eine eigene
    Heuristik trifft die Codec-Wahl nicht (bei 1080p liegen AVC1 und AV1
    um den Faktor zwei auseinander).
    """
    cmd = [YTDLP, "--load-info-json", info_path, "--ignore-config", "--no-update",
           "--no-warnings", "--simulate", "--quiet",
           "-f", selector, "--print", "%(format_id)s"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30,
                                env=child_env(), encoding="utf-8", errors="replace",
                                **_quiet_flags())
    except Exception:
        return None
    if result.returncode != 0:
        return None
    lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    return lines[-1].split("+") if lines else None


def _format_size(fmt):
    return fmt.get("filesize") or fmt.get("filesize_approx") or 0


def exact_sizes(info, heights, audio_wanted=True):
    """Liefert je Auflösung die Summe der Formate, die yt-dlp wirklich nimmt."""
    by_id = {f.get("format_id"): f for f in (info.get("formats") or [])}
    handle, info_path = tempfile.mkstemp(suffix=".info.json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as fh:
            json.dump(info, fh)

        jobs = {}
        for height in heights:
            jobs[("video", height)] = build_format_selector(
                {"height": height, "forceH264": False})
        if audio_wanted:
            jobs[("audio", 0)] = "ba/b"

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = dict(zip(
                jobs.keys(),
                pool.map(lambda sel: _selected_format_ids(info_path, sel), jobs.values())))
    finally:
        try:
            os.unlink(info_path)
        except OSError:
            pass

    sizes = {}
    for key, ids in results.items():
        if not ids:
            continue
        total = sum(_format_size(by_id.get(fid) or {}) for fid in ids)
        sizes[key] = total or None
    return sizes



def run_probe(job_id, url, output_dir=None):
    try:
        url = validate_url(url)
    except Exception as exc:
        send({"type": "error", "id": job_id, "message": str(exc)})
        return
    if not YTDLP:
        send({"type": "error", "id": job_id, "message": "yt-dlp fehlt."})
        return

    cmd = [YTDLP, "--dump-single-json", "--no-playlist", "--no-warnings",
           "--ignore-config", "--socket-timeout", "15", "--", url]
    try:
        result = subprocess.run(cmd, capture_output=True, env=child_env(),
                                timeout=45, text=True, encoding="utf-8",
                                errors="replace", **_quiet_flags())
    except subprocess.TimeoutExpired:
        send({"type": "error", "id": job_id,
              "message": "Zeitüberschreitung beim Abfragen der Formate."})
        return
    if result.returncode != 0:
        send({"type": "error", "id": job_id,
              "message": humanize_error(result.stderr or "", result.returncode)})
        return

    try:
        info = json.loads(result.stdout)
    except Exception:
        send({"type": "error", "id": job_id,
              "message": "Antwort von yt-dlp nicht lesbar."})
        return

    # Die tatsächlich vorhandenen Auflösungen, nicht eine feste Leiter.
    present = {}
    for fmt in info.get("formats") or []:
        if (fmt.get("vcodec") or "none") == "none":
            continue
        height = fmt.get("height")
        if not height:
            continue
        present.setdefault(height, set()).add(str(fmt.get("vcodec") or ""))

    ordered = sorted(present, reverse=True)[:8]
    sizes = exact_sizes(info, ordered) if ordered else {}

    heights = []
    for height in ordered:
        heights.append({
            "height": height,
            "size": sizes.get(("video", height)),
            "h264": any(codec.startswith("avc1") for codec in present[height]),
        })
    best_audio = sizes.get(("audio", 0))

    try:
        already = partial_bytes(resolve_output_dir(output_dir), info.get("id"))
    except Exception:
        already = None

    send({
        "type": "probe",
        "id": job_id,
        "partialBytes": already,
        "title": info.get("title"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "videoId": info.get("id"),
        "isLive": bool(info.get("is_live")),
        "heights": heights,
        "audioSize": best_audio,
    })


# --------------------------------------------------------------- Werkzeuge ---

def _inside_home(path):
    target = os.path.realpath(os.path.expanduser(str(path)))
    home = os.path.realpath(str(Path.home()))
    try:
        return target if os.path.commonpath([target, home]) == home else None
    except ValueError:
        return None      # verschiedene Laufwerke unter Windows


def reveal_in_finder(path):
    target = _inside_home(path)
    if not target or not os.path.exists(target):
        return False
    if IS_WINDOWS:
        # explorer liefert immer Exitcode 1, deshalb Popen ohne Prüfung.
        subprocess.Popen(["explorer", "/select,", target], **_quiet_flags())
    else:
        subprocess.Popen(["/usr/bin/open", "-R", target],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def open_path(path):
    target = _inside_home(path)
    if not target or not os.path.exists(target):
        return False
    if IS_WINDOWS:
        os.startfile(target)                                  # noqa: S606
    else:
        subprocess.Popen(["/usr/bin/open", target],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True


def tool_version(binary, args):
    if not binary:
        return None
    try:
        result = subprocess.run([binary] + args, capture_output=True,
                                timeout=10, text=True, env=child_env(),
                                **_quiet_flags())
        return (result.stdout or result.stderr).strip().splitlines()[0]
    except Exception:
        return None


def status_payload(job_id=None):
    ffmpeg_version = tool_version(FFMPEG, ["-version"])
    if ffmpeg_version:
        ffmpeg_version = ffmpeg_version.replace("ffmpeg version ", "").split()[0]
    return {
        "type": "pong",
        "id": job_id,
        "hostVersion": HOST_VERSION,
        "python": "%d.%d.%d" % sys.version_info[:3],
        "ytdlp": {"path": YTDLP, "version": tool_version(YTDLP, ["--version"])},
        "ffmpeg": {"path": FFMPEG, "version": ffmpeg_version},
        "defaultDir": str(Path.home() / "Downloads" / "YouTube"),
        "ready": bool(YTDLP and FFMPEG),
    }


def run_update(job_id):
    global YTDLP
    steps = []
    if not YTDLP:
        send({"type": "error", "id": job_id, "message": "yt-dlp fehlt."})
        return

    # Von Homebrew installierte Fassungen aktualisiert brew; alles andere
    # kann sich mit -U selbst ersetzen.
    brew = find_binary("brew")
    from_brew = any(prefix in YTDLP for prefix in ("/homebrew/", "/usr/local/"))
    cmd = [brew, "upgrade", "yt-dlp"] if (brew and from_brew) else [YTDLP, "-U"]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=300,
                                text=True, env=child_env(), **_quiet_flags())
        steps.append((result.stdout or "") + (result.stderr or ""))
    except Exception as exc:
        send({"type": "error", "id": job_id, "message": str(exc)})
        return
    YTDLP = find_binary("yt-dlp")
    send({"type": "updated", "id": job_id,
          "version": tool_version(YTDLP, ["--version"]),
          "output": "\n".join(steps)[-1200:]})


# ------------------------------------------------------------- Hauptschleife ---

def heartbeat_loop():
    """Hält den MV3-Service-Worker am Leben, solange etwas läuft."""
    while True:
        time.sleep(15)
        if JOBS.count() > 0:
            send({"type": "heartbeat", "active": JOBS.count()})


def handle(message):
    command = message.get("cmd")
    job_id = message.get("id")

    if command == "ping":
        send(status_payload(job_id))
    elif command == "download":
        threading.Thread(
            target=run_download,
            args=(job_id, message.get("url"), message.get("opts") or {}),
            daemon=True,
        ).start()
    elif command == "probe":
        threading.Thread(
            target=run_probe,
            args=(job_id, message.get("url"), message.get("outputDir")),
            daemon=True).start()
    elif command == "partials":
        try:
            out_dir = resolve_output_dir(message.get("outputDir"))
            send({"type": "partials", "id": job_id,
                  "items": partial_files(out_dir)})
        except Exception as exc:
            send({"type": "error", "id": job_id, "message": str(exc)})
    elif command == "discardPartials":
        try:
            out_dir = resolve_output_dir(message.get("outputDir"))
            removed = discard_partials(out_dir, message.get("videoId"))
            send({"type": "partialsDiscarded", "id": job_id, "removed": removed})
        except Exception as exc:
            send({"type": "error", "id": job_id, "message": str(exc)})
    elif command == "cancel":
        ok = JOBS.cancel(message.get("target") or job_id)
        send({"type": "cancelRequested", "id": job_id, "ok": ok})
    elif command == "reveal":
        send({"type": "revealed", "id": job_id,
              "ok": reveal_in_finder(message.get("path"))})
    elif command == "open":
        send({"type": "opened", "id": job_id, "ok": open_path(message.get("path"))})
    elif command == "openDir":
        try:
            target = resolve_output_dir(message.get("path"))
            send({"type": "opened", "id": job_id, "ok": open_path(str(target))})
        except Exception as exc:
            send({"type": "error", "id": job_id, "message": str(exc)})
    elif command == "update":
        threading.Thread(target=run_update, args=(job_id,), daemon=True).start()
    else:
        send({"type": "error", "id": job_id,
              "message": "Unbekannter Befehl: %r" % command})


def main():
    log("Host gestartet", HOST_VERSION, "yt-dlp:", YTDLP, "ffmpeg:", FFMPEG)
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    try:
        while True:
            message = read_message()
            if message is None:
                break
            try:
                handle(message)
            except Exception:
                log("Fehler beim Verarbeiten:", traceback.format_exc())
                send({"type": "error", "id": message.get("id"),
                      "message": "Interner Fehler im Host. Details im Log."})
    except Exception:
        log("Hauptschleife abgebrochen:", traceback.format_exc())
    finally:
        JOBS.cancel_all()
        log("Host beendet")


if __name__ == "__main__":
    main()
