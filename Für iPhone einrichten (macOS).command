#!/bin/sh
# Doppelklicken, wenn Videos auch auf dem iPhone landen sollen.
cd "$(dirname "$0")" || exit 1
exec /bin/bash "scripts/iphone-macos.sh"
