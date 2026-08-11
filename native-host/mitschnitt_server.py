#!/usr/bin/env python3
"""
Begleitdienst für iPhone und iPad.

Auf iOS lässt sich yt-dlp nicht ausführen — kein Prozessstart, kein ffmpeg.
Deshalb macht die Arbeit weiterhin dieser Rechner, und das iPhone holt sich
das Ergebnis über das eigene WLAN ab. Es entsteht kein Dienst im Internet,
nichts verlässt das Heimnetz.

Zwei Wege führen zum selben Punkt:
  · Safari auf dem iPhone öffnet die Adresse und bekommt eine Oberfläche.
  · Ein Kurzbefehl spricht dieselben Endpunkte über HTTP an.

Start:  python3 native-host/mitschnitt_server.py
Ports und Zielordner über Umgebungsvariablen:
  MITSCHNITT_PORT (Vorgabe 8787), MITSCHNITT_DIR, MITSCHNITT_BIND
"""

import hmac
import json
import mimetypes
import os
import re
import secrets
import socket
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ytdl_host as core          # noqa: E402  — derselbe Download-Weg

SERVER_VERSION = "1.0.0"
PORT = int(os.environ.get("MITSCHNITT_PORT", "8787"))
BIND = os.environ.get("MITSCHNITT_BIND", "0.0.0.0")
OUTPUT_DIR = os.environ.get("MITSCHNITT_DIR", "Downloads/Mitschnitt")

# Fertige Dateien werden nach dieser Zeit nicht mehr zum Abruf angeboten.
# Auf der Platte bleiben sie liegen — nur der Link läuft ab.
JOB_TTL = 6 * 3600


# ------------------------------------------------------------------ Zugang ---

def _state_dir():
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Mitschnitt"
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "Mitschnitt"
    return Path.home() / ".config" / "mitschnitt"


def load_token():
    """
    Ohne Schlüssel könnte jedes Gerät im Netz Downloads auslösen. Der
    Schlüssel liegt nur auf diesem Rechner und wandert einmal ins iPhone.
    """
    path = _state_dir() / "token"
    if path.exists():
        value = path.read_text(encoding="utf-8").strip()
        if value:
            return value
    path.parent.mkdir(parents=True, exist_ok=True)
    value = secrets.token_urlsafe(18)
    path.write_text(value, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return value


TOKEN = load_token()


def lan_address():
    """Die Adresse, unter der das iPhone diesen Rechner erreicht."""
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("192.0.2.1", 1))      # geht nirgendwohin, nur Routing
        address = probe.getsockname()[0]
        probe.close()
        return address
    except Exception:
        return "127.0.0.1"


# -------------------------------------------------------------------- Jobs ---

JOBS = {}
JOBS_LOCK = threading.Lock()


def new_job(url, opts):
    job_id = secrets.token_urlsafe(9)
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id, "url": url, "opts": opts, "state": "start",
            "percent": None, "speed": None, "eta": None, "stage": None,
            "title": None, "path": None, "filename": None, "size": None,
            "error": None, "resumable": False, "created": time.time(),
        }
    return job_id


def update_job(job_id, **fields):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job:
            job.update(fields)


def public_job(job):
    return {key: job.get(key) for key in
            ("id", "state", "percent", "speed", "eta", "stage", "title",
             "filename", "size", "error", "resumable")}


def sweep_jobs():
    cutoff = time.time() - JOB_TTL
    with JOBS_LOCK:
        for job_id in [k for k, v in JOBS.items()
                       if v["created"] < cutoff and v["state"] in ("done", "error")]:
            JOBS.pop(job_id, None)


def start_download(job_id):
    """Führt den Download aus und übersetzt die Meldungen in den Jobzustand."""
    job = JOBS[job_id]
    opts = dict(job["opts"])
    opts.setdefault("outputDir", OUTPUT_DIR)

    def collect(message):
        kind = message.get("type")
        if kind == "progress":
            update_job(job_id, state="running", percent=message.get("percent"),
                       speed=message.get("speed"), eta=message.get("eta"),
                       stage=None if message.get("status") == "downloading"
                             else message.get("status"))
        elif kind == "stage":
            update_job(job_id, state="running", stage=message.get("stage"))
        elif kind == "meta":
            update_job(job_id, title=message.get("title"))
        elif kind == "done":
            update_job(job_id, state="done", percent=100.0,
                       path=message.get("path"), filename=message.get("filename"),
                       size=message.get("size"), title=message.get("title"))
        elif kind == "error":
            update_job(job_id, state="error", error=message.get("message"),
                       resumable=bool(message.get("resumable")))
        elif kind == "cancelled":
            update_job(job_id, state="cancelled")

    try:
        core.run_download(job_id, job["url"], opts, emit=collect)
    except Exception as exc:                                    # noqa: BLE001
        core.log("SERVER Download gescheitert:", exc)
        update_job(job_id, state="error", error=str(exc))


# ------------------------------------------------------------- Oberfläche ---

PAGE = """<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Mitschnitt">
<meta name="theme-color" content="#0B0B0D">
<title>Mitschnitt</title>
<style>
:root{
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  --ui:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;
  --bg:#0B0B0D;--surface:#17171B;--line:#2A2A33;--line-strong:#3D3D48;
  --fg:#F2F2F5;--muted:#9A9AA6;--faint:#6A6A76;
  --accent:#3ED8D8;--accent-ink:#5FE6E6;--accent-soft:rgba(62,216,216,.14);
  --on-accent:#05252B;--danger:#FF7A6B;--danger-soft:rgba(255,122,107,.12);
}
@media (prefers-color-scheme:light){:root{
  --bg:#FFF;--surface:#F2F2F5;--line:#E2E2E8;--line-strong:#C6C6D0;
  --fg:#0B0B0D;--muted:#5C5C68;--faint:#8A8A96;
  --accent:#0E9C9C;--accent-ink:#0A7E7E;--accent-soft:rgba(14,156,156,.10);
  --on-accent:#FFF;--danger:#C0392B;--danger-soft:rgba(192,57,43,.09);
}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--ui);
  font-size:16px;-webkit-font-smoothing:antialiased;
  padding:max(18px,env(safe-area-inset-top)) 18px max(24px,env(safe-area-inset-bottom))}
main{max-width:520px;margin:0 auto}
header{display:flex;align-items:center;gap:11px;margin-bottom:22px}
.mark{width:30px;height:30px;border-radius:8px;overflow:hidden;flex:none;
  background:linear-gradient(90deg,#BFBFBF 0 14.28%,#BFBF00 14.28% 28.56%,
  #00BFBF 28.56% 42.84%,#00BF00 42.84% 57.12%,#BF00BF 57.12% 71.4%,
  #BF0000 71.4% 85.68%,#0000BF 85.68% 100%)}
h1{margin:0;font-size:17px;font-weight:600;letter-spacing:-.01em}
.sub{margin:2px 0 0;font-family:var(--mono);font-size:10.5px;color:var(--muted)}
.legend{margin:0 0 8px;font-family:var(--mono);font-size:9.5px;font-weight:600;
  letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
input[type=url]{width:100%;padding:13px 14px;border:1px solid var(--line);
  border-radius:11px;background:var(--surface);color:var(--fg);
  font-family:var(--mono);font-size:16px}
input[type=url]:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-soft)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 4px}
.chip{border:1px solid var(--line);background:transparent;color:var(--fg);
  border-radius:9px;padding:9px 13px;font-family:var(--mono);font-size:13px;
  font-variant-numeric:tabular-nums;cursor:pointer}
.chip[aria-checked=true]{border-color:var(--accent);color:var(--accent-ink);
  background:var(--accent-soft)}
.chip:disabled{opacity:.35}
section{margin-bottom:20px}
.go{width:100%;border:0;border-radius:12px;padding:15px;font-family:var(--ui);
  font-size:16px;font-weight:600;background:var(--accent);color:var(--on-accent);
  cursor:pointer}
.go:disabled{opacity:.5}
.go.ghost{background:var(--surface);color:var(--fg);
  box-shadow:inset 0 0 0 1px var(--line);margin-top:8px}
.bars{position:relative;height:7px;border-radius:4px;overflow:hidden;
  background:var(--surface);margin:14px 0 9px}
.strip{position:absolute;top:0;bottom:0;left:0;width:0%;display:flex;
  transition:width .3s ease}
.strip i{flex:1}
.status{margin:0;font-family:var(--mono);font-size:12px;color:var(--muted);
  font-variant-numeric:tabular-nums;line-height:1.5;word-break:break-word}
.status[data-tone=ok]{color:var(--accent-ink)}
.status[data-tone=error]{color:var(--danger)}
.spec{margin:8px 0 0;font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.card{border:1px solid var(--line);border-radius:13px;padding:15px}
.hint{margin:22px 0 0;font-family:var(--mono);font-size:10.5px;color:var(--faint);
  line-height:1.6}
a{color:var(--accent-ink)}
</style>
</head>
<body>
<main>
  <header>
    <span class="mark" aria-hidden="true"></span>
    <div>
      <h1>Mitschnitt</h1>
      <p class="sub" id="host">bereit</p>
    </div>
  </header>

  <section>
    <p class="legend">Adresse</p>
    <input type="url" id="url" inputmode="url" autocapitalize="off"
           autocorrect="off" spellcheck="false"
           placeholder="Link einfügen">
    <p class="spec" id="spec"></p>
  </section>

  <section>
    <p class="legend">Was</p>
    <div class="chips" id="modes">
      <button class="chip" data-mode="video" aria-checked="true">Video</button>
      <button class="chip" data-mode="audio" aria-checked="false">Audio</button>
    </div>
  </section>

  <section id="quality-section">
    <p class="legend">Auflösung</p>
    <div class="chips" id="heights"></div>
  </section>

  <section class="card">
    <button class="go" id="start">Herunterladen</button>
    <button class="go ghost" id="save" hidden>Auf dem iPhone sichern</button>
    <div class="bars"><span class="strip" id="strip"></span></div>
    <p class="status" id="status">Link einfügen und starten.</p>
  </section>

  <p class="hint" id="hint"></p>
</main>
<script>
const SMPTE=['#BFBFBF','#BFBF00','#00BFBF','#00BF00','#BF00BF','#BF0000','#0000BF'];
document.getElementById('strip').innerHTML=SMPTE.map(c=>`<i style="background:${c}"></i>`).join('');
const q=new URLSearchParams(location.search);
const TOKEN=q.get('t')||'';
const el=id=>document.getElementById(id);
let mode='video', height=1080, probe=null, job=null, timer=null;

function api(path,body){
  const opt={headers:{'X-Token':TOKEN}};
  if(body){opt.method='POST';opt.headers['Content-Type']='application/json';
           opt.body=JSON.stringify(body);}
  return fetch(path,opt).then(r=>r.json());
}
function bytes(v){if(!v&&v!==0)return '';const u=['B','KB','MB','GB'];let n=v,i=0;
  while(n>=1024&&i<u.length-1){n/=1024;i++}
  return (n<10&&i>0?n.toFixed(1):Math.round(n))+' '+u[i];}
function clock(s){if(s==null)return '';s=Math.round(s);
  const m=Math.floor(s/60);return m+':'+String(s%60).padStart(2,'0');}

function renderHeights(){
  const box=el('heights');
  const list=(probe&&probe.heights&&probe.heights.length)
    ? probe.heights.map(h=>h.height) : [2160,1440,1080,720,480,360];
  if(!list.includes(height)){
    const below=list.filter(h=>h<=height);
    height=below.length?below[0]:list[0];
  }
  box.innerHTML=list.map(h=>
    `<button class="chip" data-h="${h}" aria-checked="${h===height}">${h}p</button>`).join('');
  box.querySelectorAll('[data-h]').forEach(b=>b.onclick=()=>{
    height=+b.dataset.h; renderHeights(); renderSpec();});
  el('quality-section').hidden = (mode==='audio');
}
function renderSpec(){
  if(!probe){el('spec').textContent='';return;}
  if(mode==='audio'){
    el('spec').textContent='mp3 · '+(probe.audioSize?bytes(probe.audioSize):'');
    return;
  }
  const m=(probe.heights||[]).find(h=>h.height===height);
  el('spec').textContent=[probe.title,m&&m.size?bytes(m.size):null]
    .filter(Boolean).join(' · ');
}

let probeTimer=null;
el('url').addEventListener('input',()=>{
  clearTimeout(probeTimer); probe=null; renderSpec();
  const url=el('url').value.trim();
  if(!/^https?:\\/\\//.test(url))return;
  probeTimer=setTimeout(async()=>{
    el('status').textContent='Formate werden geprüft …';
    const r=await api('/api/probe',{url});
    if(r.ok){probe=r.data;renderHeights();renderSpec();
             el('status').textContent='Bereit.';}
    else{el('status').textContent=r.error||'Konnte nicht gelesen werden.';}
  },600);
});

el('modes').querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{
  mode=b.dataset.mode;
  el('modes').querySelectorAll('[data-mode]').forEach(o=>
    o.setAttribute('aria-checked',String(o===b)));
  renderHeights(); renderSpec();
});

el('start').onclick=async()=>{
  const url=el('url').value.trim();
  if(!url){el('status').textContent='Erst einen Link einfügen.';return;}
  el('start').disabled=true; el('save').hidden=true;
  el('status').removeAttribute('data-tone');
  el('status').textContent='Wird vorbereitet …';
  const r=await api('/api/download',{url,opts:{mode,height,audioFormat:'mp3'}});
  if(!r.ok){finish(null,r.error);return;}
  job=r.id; poll();
};

function poll(){
  clearInterval(timer);
  timer=setInterval(async()=>{
    const r=await api('/api/status?id='+encodeURIComponent(job));
    if(!r.ok){finish(null,r.error);return;}
    const j=r.job;
    el('strip').style.width=(j.percent||0)+'%';
    if(j.state==='running'||j.state==='start'){
      el('status').textContent=[
        j.stage||'Lädt', j.percent!=null?j.percent.toFixed(0)+' %':null,
        j.speed?bytes(j.speed)+'/s':null,
        j.eta!=null?'noch '+clock(j.eta):null].filter(Boolean).join('  ·  ');
    } else if(j.state==='done'){ finish(j); }
    else if(j.state==='error'){ finish(null,j.error); }
    else if(j.state==='cancelled'){ finish(null,'Abgebrochen.'); }
  },700);
}

function finish(j,error){
  clearInterval(timer); el('start').disabled=false;
  if(error){
    el('strip').style.width='0%';
    el('status').dataset.tone='error'; el('status').textContent=error;
    return;
  }
  el('strip').style.width='100%';
  el('status').dataset.tone='ok';
  el('status').textContent=j.filename+'  ·  '+bytes(j.size);
  const save=el('save');
  save.hidden=false;
  save.onclick=()=>{ location.href='/api/file?id='+encodeURIComponent(job)
                                 +'&t='+encodeURIComponent(TOKEN); };
}

api('/api/ping').then(r=>{
  if(r.ok){
    el('host').textContent='yt-dlp '+(r.ytdlp||'?')+' · ffmpeg '+(r.ffmpeg||'?');
    el('hint').textContent='Läuft auf '+r.host+'. Nur in deinem WLAN erreichbar.';
  } else { el('host').textContent='nicht bereit'; }
});
if(q.get('url')){ el('url').value=q.get('url');
  el('url').dispatchEvent(new Event('input')); }
</script>
</body>
</html>
"""


# ------------------------------------------------------------------ Server ---

class Handler(BaseHTTPRequestHandler):
    server_version = "Mitschnitt/" + SERVER_VERSION

    def log_message(self, fmt, *args):        # nicht nach stderr rauschen
        # Der Schlüssel darf in der Adresse stehen, aber nicht im Logfile.
        line = re.sub(r"([?&]t=)[^&\s\"]+", r"\1…", fmt % args)
        core.log("SERVER", self.address_string(), line)

    # -- Hilfen -------------------------------------------------------------

    def _token_ok(self):
        supplied = self.headers.get("X-Token") or self._query().get("t", [""])[0]
        return hmac.compare_digest(str(supplied), TOKEN)

    def _query(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def _path(self):
        return urllib.parse.urlparse(self.path).path

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    # -- Routen -------------------------------------------------------------

    def do_GET(self):                                        # noqa: N802
        path = self._path()

        if path in ("/", "/index.html"):
            # Die Seite selbst ist harmlos; ohne gültigen Schlüssel taugen
            # ihre Knöpfe nur nicht.
            body = PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if not self._token_ok():
            self._json({"ok": False, "error": "Schlüssel fehlt oder stimmt nicht."}, 403)
            return

        if path == "/api/ping":
            info = core.status_payload()
            self._json({"ok": bool(info.get("ready")),
                        "ytdlp": (info.get("ytdlp") or {}).get("version"),
                        "ffmpeg": (info.get("ffmpeg") or {}).get("version"),
                        "host": f"{lan_address()}:{PORT}",
                        "version": SERVER_VERSION})
            return

        if path == "/api/status":
            job_id = self._query().get("id", [""])[0]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if not job:
                self._json({"ok": False, "error": "Unbekannter Auftrag."}, 404)
                return
            self._json({"ok": True, "job": public_job(job)})
            return

        if path == "/api/file":
            self._send_file(self._query().get("id", [""])[0])
            return

        if path == "/api/grab":
            # Derselbe Vorgang wie per POST, nur mit Adressparametern:
            # ein Kurzbefehl kommt so mit einer einzigen Aktion aus, ohne
            # Kopfzeilen und ohne JSON-Text.
            query = self._query()
            opts = {"mode": query.get("mode", ["video"])[0]}
            try:
                opts["height"] = int(query.get("height", ["1080"])[0])
            except ValueError:
                opts["height"] = 1080
            if query.get("format"):
                opts["audioFormat"] = query["format"][0]
            self._grab(query.get("url", [""])[0], opts)
            return

        self._json({"ok": False, "error": "Unbekannter Pfad."}, 404)

    def do_POST(self):                                       # noqa: N802
        if not self._token_ok():
            self._json({"ok": False, "error": "Schlüssel fehlt oder stimmt nicht."}, 403)
            return
        path = self._path()
        payload = self._body()

        if path == "/api/probe":
            result = {}
            done = threading.Event()

            def collect(message):
                if message.get("type") in ("probe", "error"):
                    result.update(message)
                    done.set()

            threading.Thread(
                target=core.run_probe,
                args=("probe", payload.get("url"), OUTPUT_DIR, collect),
                daemon=True).start()
            if not done.wait(60):
                self._json({"ok": False, "error": "Zeitüberschreitung."}, 504)
                return
            if result.get("type") == "error":
                self._json({"ok": False, "error": result.get("message")}, 400)
                return
            self._json({"ok": True, "data": result})
            return

        if path == "/api/download":
            try:
                url = core.validate_url(payload.get("url"))
            except Exception as exc:                          # noqa: BLE001
                self._json({"ok": False, "error": str(exc)}, 400)
                return
            sweep_jobs()
            job_id = new_job(url, payload.get("opts") or {})
            threading.Thread(target=start_download, args=(job_id,),
                             daemon=True).start()
            self._json({"ok": True, "id": job_id})
            return

        if path == "/api/grab":
            self._grab(payload.get("url"), payload.get("opts") or {})
            return

        if path == "/api/cancel":
            core.JOBS.cancel(payload.get("id"))
            self._json({"ok": True})
            return

        self._json({"ok": False, "error": "Unbekannter Pfad."}, 404)

    # -- Datei ausliefern ---------------------------------------------------

    def _grab(self, url, opts):
        """
        Ein Aufruf, eine Datei. Der Kurzbefehl auf dem iPhone kann weder
        Schleifen noch Zwischenstände gebrauchen — er schickt die Adresse
        und bekommt das fertige Video zurück.
        """
        try:
            url = core.validate_url(url)
        except Exception as exc:                              # noqa: BLE001
            self._json({"ok": False, "error": str(exc)}, 400)
            return

        opts = dict(opts)
        opts.setdefault("mode", "video")
        opts.setdefault("height", 1080)
        sweep_jobs()
        job_id = new_job(url, opts)
        start_download(job_id)              # bewusst im Anfrage-Thread

        with JOBS_LOCK:
            job = dict(JOBS.get(job_id) or {})
        if job.get("state") != "done":
            self._json({"ok": False,
                        "error": job.get("error") or "Download fehlgeschlagen."},
                       502)
            return
        self._deliver(job)

    def _send_file(self, job_id):
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if not job or job.get("state") != "done" or not job.get("path"):
            self._json({"ok": False, "error": "Noch nichts fertig."}, 404)
            return
        self._deliver(job)

    def _deliver(self, job):
        path = job["path"]
        # Doppelte Absicherung: nur was im Benutzerordner liegt, geht raus.
        if not core._inside_home(path) or not os.path.exists(path):
            self._json({"ok": False, "error": "Datei nicht mehr vorhanden."}, 410)
            return

        size = os.path.getsize(path)
        name = job.get("filename") or os.path.basename(path)
        guess = mimetypes.guess_type(name)[0] or "application/octet-stream"

        self.send_response(200)
        self.send_header("Content-Type", guess)
        self.send_header("Content-Length", str(size))
        # RFC-5987, damit Umlaute im Dateinamen ankommen.
        quoted = urllib.parse.quote(name)
        self.send_header("Content-Disposition",
                         f"attachment; filename*=UTF-8''{quoted}")
        self.end_headers()
        try:
            with open(path, "rb") as handle:
                while True:
                    chunk = handle.read(256 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            core.log("SERVER Übertragung abgebrochen:", name)


def main():
    if not core.YTDLP:
        print("yt-dlp wurde nicht gefunden. Bitte zuerst die Einrichtung starten.")
        raise SystemExit(1)

    address = lan_address()
    url = f"http://{address}:{PORT}/?t={TOKEN}"
    # Bewusst ohne Schlüssel: das Logfile wird gelesen und weitergereicht.
    core.log("SERVER startet auf", f"{BIND}:{PORT}", "erreichbar über", address)

    # Ohne flush landet die Startmeldung im Puffer — unter launchd sieht
    # man sie dann erst beim Beenden.
    say = lambda text="": print(text, flush=True)   # noqa: E731

    say()
    say("  Mitschnitt läuft.")
    say()
    say("  Auf dem iPhone im selben WLAN diese Adresse öffnen:")
    say()
    say("      " + url)
    say()
    say("  Schlüssel für den Kurzbefehl: " + TOKEN)
    say()

    server = ThreadingHTTPServer((BIND, PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        core.JOBS.cancel_all()


if __name__ == "__main__":
    main()
