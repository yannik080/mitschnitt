# Schlüssel

`extension_key.pem` erzeugt die feste Extension-ID. Sie steht als
öffentlicher Teil im `key`-Feld von `extension/manifest.json`; nur deshalb
kann `install.sh` den Native Host registrieren, bevor die Extension geladen
ist.

- `extension_key.pem` — privater Schlüssel, gehört nicht in ein Repository
- `manifest_key.txt` — der öffentliche Teil, wie er im Manifest steht
- `extension_id.txt` — die daraus abgeleitete ID

Geht der private Schlüssel verloren, ändert sich die ID beim Neuerzeugen und
`install.sh` muss erneut laufen. Neu erzeugen:

    openssl genrsa -out keys/extension_key.pem 2048
    python3 tools/derive_id.py
