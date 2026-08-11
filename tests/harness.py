#!/usr/bin/env python3
"""
Testtreiber für den Native Host: spricht dasselbe Protokoll wie Chrome,
schreibt jede empfangene Nachricht mit und beendet sich, sobald ein
Endzustand erreicht ist.

    python3 tests/harness.py ping
    python3 tests/harness.py probe <url>
    python3 tests/harness.py download <url> [json-opts]
    python3 tests/harness.py cancel <url>   # startet und bricht nach 3 s ab
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
TERMINAL = {"done", "error", "cancelled", "pong", "probe", "updated",
            "revealed", "opened"}


def encode(message):
    payload = json.dumps(message).encode("utf-8")
    return struct.pack("<I", len(payload)) + payload


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "ping"
    url = sys.argv[2] if len(sys.argv) > 2 else ""
    opts = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}

    proc = subprocess.Popen([sys.executable, HOST],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)

    stderr_out = []
    threading.Thread(
        target=lambda: stderr_out.append(proc.stderr.read().decode("utf-8", "replace")),
        daemon=True).start()

    if action == "ping":
        proc.stdin.write(encode({"cmd": "ping", "id": "t1"}))
    elif action == "probe":
        proc.stdin.write(encode({"cmd": "probe", "id": "t1", "url": url}))
    else:
        proc.stdin.write(encode({"cmd": "download", "id": "t1",
                                 "url": url, "opts": opts}))
    proc.stdin.flush()

    if action == "cancel":
        def kill_later():
            time.sleep(3)
            proc.stdin.write(encode({"cmd": "cancel", "id": "c1", "target": "t1"}))
            proc.stdin.flush()
        threading.Thread(target=kill_later, daemon=True).start()

    started = time.time()
    progress_count = 0
    exit_code = 1

    while True:
        if time.time() - started > 300:
            print("!! Zeitüberschreitung")
            break
        header = proc.stdout.read(4)
        if len(header) < 4:
            print("!! Host hat die Verbindung geschlossen")
            break
        (length,) = struct.unpack("<I", header)
        message = json.loads(proc.stdout.read(length).decode("utf-8"))
        kind = message.get("type")

        if kind == "progress":
            progress_count += 1
            if progress_count % 12 == 1:
                pct = message.get("percent")
                print("   %5s%%  %8s B/s  eta %ss  [%s]" % (
                    "%.1f" % pct if pct is not None else "  ?",
                    int(message["speed"]) if message.get("speed") else "?",
                    message.get("eta"), message.get("status")))
        elif kind == "heartbeat":
            pass
        else:
            print("<< %s" % json.dumps(message, ensure_ascii=False)[:600])

        if kind in TERMINAL:
            exit_code = 0 if kind in ("done", "pong", "probe", "cancelled",
                                      "updated", "revealed", "opened") else 2
            break

    print("-- Progress-Nachrichten: %d, Dauer: %.1fs" %
          (progress_count, time.time() - started))
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.terminate()
    time.sleep(0.3)
    err = "".join(stderr_out).strip()
    if err:
        print("!! Host-stderr:\n%s" % err[:2000])
        exit_code = 3
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
