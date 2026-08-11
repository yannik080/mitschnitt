#!/usr/bin/env python3
"""
Prüft, ob ein abgebrochener Download beim zweiten Anlauf fortgesetzt wird,
statt von vorne zu beginnen.

Ablauf: Download starten → nach N Sekunden abbrechen → angefangene Bytes
abfragen → erneut starten → erste Fortschrittsmeldung ansehen. Setzt der
zweite Lauf fort, liegt der Startwert deutlich über null.
"""

import json
import os
import struct
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST = os.path.join(ROOT, "native-host", "ytdl_host.py")

URL = sys.argv[1] if len(sys.argv) > 1 else \
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
OUT = "Downloads/YouTube-ResumeTest"
OPTS = {"mode": "video", "height": 1080, "container": "mp4", "outputDir": OUT}


def encode(message):
    payload = json.dumps(message).encode("utf-8")
    return struct.pack("<I", len(payload)) + payload


class Host:
    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, HOST],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL)
        self.messages = []
        self.lock = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while True:
            header = self.proc.stdout.read(4)
            if len(header) < 4:
                return
            (length,) = struct.unpack("<I", header)
            message = json.loads(self.proc.stdout.read(length).decode("utf-8"))
            with self.lock:
                self.messages.append(message)
                self.lock.notify_all()

    def send(self, message):
        self.proc.stdin.write(encode(message))
        self.proc.stdin.flush()

    def wait_for(self, predicate, timeout=120):
        deadline = time.time() + timeout
        with self.lock:
            while True:
                for message in self.messages:
                    if predicate(message):
                        return message
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None
                self.lock.wait(min(remaining, 1))

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.terminate()


def first_progress_percent(host, job_id, timeout=60):
    """Erste Fortschrittsmeldung mit belastbarem Prozentwert."""
    deadline = time.time() + timeout
    seen = 0
    while time.time() < deadline:
        with host.lock:
            batch = [m for m in host.messages[seen:]]
            seen = len(host.messages)
        for message in batch:
            if message.get("type") == "progress" and message.get("id") == job_id:
                if message.get("percent") is not None:
                    return message
            if message.get("type") in ("done", "error") and message.get("id") == job_id:
                return message
        time.sleep(0.2)
    return None


def main():
    failures = []
    host = Host()

    print("── Lauf 1: starten, bis 5 MB geladen sind, dann abbrechen")
    host.send({"cmd": "download", "id": "a", "url": URL, "opts": OPTS})
    if not host.wait_for(lambda m: m.get("type") == "started", 30):
        print("!! Download startete nicht"); host.close(); sys.exit(1)

    # Auf echten Fortschritt warten statt blind zu schlafen: wie lange
    # yt-dlp für die Metadaten braucht, schwankt stark.
    marker = host.wait_for(
        lambda m: (m.get("type") == "progress" and m.get("id") == "a"
                   and (m.get("downloaded") or 0) > 5_000_000), 120)
    if not marker:
        print("!! Es wurden keine 5 MB geladen"); host.close(); sys.exit(1)
    print(f"   geladen: {marker['downloaded']:.0f} Bytes")
    host.send({"cmd": "cancel", "id": "c", "target": "a"})
    cancelled = host.wait_for(lambda m: m.get("type") == "cancelled", 30)
    if not cancelled:
        print("!! Kein Abbruch gemeldet"); host.close(); sys.exit(1)
    partial_after_cancel = cancelled.get("partialBytes")
    print(f"   abgebrochen, gesichert: {partial_after_cancel} Bytes")
    if not partial_after_cancel:
        failures.append("Nach dem Abbruch wurden keine Bytes gesichert.")

    print("── Angefangene Downloads abfragen")
    host.send({"cmd": "partials", "id": "p", "outputDir": OUT})
    partials = host.wait_for(lambda m: m.get("type") == "partials", 15)
    print(f"   {json.dumps(partials.get('items'), ensure_ascii=False)}")
    if not partials.get("items"):
        failures.append("Der Befehl partials liefert nichts.")

    print("── Lauf 2: erneut starten, Startpunkt prüfen")
    host.send({"cmd": "download", "id": "b", "url": URL, "opts": OPTS})
    if not host.wait_for(lambda m: m.get("type") == "started" and m.get("id") == "b", 30):
        print("!! Zweiter Lauf startete nicht"); host.close(); sys.exit(1)
    progress = first_progress_percent(host, "b")

    if not progress:
        failures.append("Der zweite Lauf meldete keinen Fortschritt.")
    elif progress.get("type") != "progress":
        failures.append(f"Unerwartet: {progress.get('type')} — {progress.get('message')}")
    else:
        percent = progress.get("percent")
        downloaded = progress.get("downloaded") or 0
        saved = partial_after_cancel or 0
        print(f"   erste Meldung: {percent:.1f} %  ({downloaded:.0f} Bytes)")
        if not saved:
            failures.append("Kein gesicherter Stand — Vergleich nicht möglich.")
        elif downloaded >= 0.9 * saved:
            print(f"   ✓ setzt bei {downloaded/saved*100:.0f} % des gesicherten "
                  f"Standes fort")
        else:
            failures.append(
                f"Der zweite Lauf beginnt bei {downloaded:.0f} Bytes, "
                f"gesichert waren aber {saved} — es wird neu geladen.")

    host.send({"cmd": "cancel", "id": "c2", "target": "b"})
    host.wait_for(lambda m: m.get("type") == "cancelled" and m.get("id") == "b", 20)

    print("── Aufräumen")
    host.send({"cmd": "discardPartials", "id": "d", "outputDir": OUT})
    discarded = host.wait_for(lambda m: m.get("type") == "partialsDiscarded", 15)
    print(f"   {discarded.get('removed')} Datei(en) gelöscht")
    if not discarded or not discarded.get("removed"):
        failures.append("discardPartials hat nichts gelöscht.")

    host.close()
    print()
    if failures:
        print("FEHLGESCHLAGEN:")
        for item in failures:
            print("  ·", item)
        sys.exit(1)
    print("Alle Prüfungen bestanden.")


if __name__ == "__main__":
    main()
