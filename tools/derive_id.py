#!/usr/bin/env python3
"""Leitet den Manifest-Schlüssel und die Extension-ID aus dem privaten
Schlüssel ab und trägt beides ein."""

import base64
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PEM = ROOT / "keys" / "extension_key.pem"

if not PEM.exists():
    raise SystemExit(f"{PEM} fehlt. Erzeugen mit:\n"
                     f"  openssl genrsa -out {PEM} 2048")

der = subprocess.run(["openssl", "rsa", "-in", str(PEM), "-pubout", "-outform", "DER"],
                     capture_output=True, check=True).stdout
manifest_key = base64.b64encode(der).decode()
digest = hashlib.sha256(der).hexdigest()[:32]
ext_id = "".join(chr(ord("a") + int(c, 16)) for c in digest)

(ROOT / "keys" / "manifest_key.txt").write_text(manifest_key)
(ROOT / "keys" / "extension_id.txt").write_text(ext_id)

manifest_path = ROOT / "extension" / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["key"] = manifest_key
manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                         encoding="utf-8")

print("Extension-ID:", ext_id)
print("manifest.json aktualisiert. Danach ./install.sh erneut ausführen.")
