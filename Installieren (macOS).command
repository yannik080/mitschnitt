#!/bin/sh
# Doppelklicken. Öffnet ein Terminalfenster und richtet alles ein.
cd "$(dirname "$0")" || exit 1
exec /bin/bash "scripts/install-macos.sh"
