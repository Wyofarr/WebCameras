#!/bin/bash
# ─────────────────────────────────────────────────────────
#  Run this INSIDE the LXC container as root.
#  It clones from GitHub and runs the full setup.
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/YOURUSER/webcameras/main/scripts/install-in-container.sh | bash
#  Or if you have the files already:
#    bash /tmp/webcameras/scripts/install-in-container.sh
# ─────────────────────────────────────────────────────────
set -e

REPO="${REPO:-https://github.com/YOURUSER/webcameras.git}"
DEST="/tmp/webcameras-install"

if [ -d "$DEST" ]; then rm -rf "$DEST"; fi

echo "[*] Installing dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends git curl 2>/dev/null

echo "[*] Cloning repo..."
git clone "$REPO" "$DEST"

echo "[*] Running setup..."
bash "$DEST/scripts/setup-lxc.sh"

rm -rf "$DEST"
