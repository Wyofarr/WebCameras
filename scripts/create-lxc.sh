#!/bin/bash
# ╔══════════════════════════════════════════════════════════╗
# ║  create-lxc.sh — Run on Proxmox HOST to create the     ║
# ║  WebCameras LXC container and install the app          ║
# ╚══════════════════════════════════════════════════════════╝
# Usage: bash create-lxc.sh [VMID] [HOSTNAME] [IP/CIDR] [GATEWAY]
# Example: bash create-lxc.sh 200 webcameras 192.168.1.200/24 192.168.1.1

set -e

VMID="${1:-200}"
HOSTNAME="${2:-webcameras}"
IP="${3:-dhcp}"
GW="${4:-}"
MEMORY="${MEMORY:-512}"   # MB
CORES="${CORES:-2}"
DISK="${DISK:-8}"         # GB
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE="ubuntu-22.04-standard_22.04-1_amd64.tar.zst"
TEMPLATE_STORE="local"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Creating WebCameras LXC Container"
echo "  VMID:     $VMID"
echo "  Hostname: $HOSTNAME"
echo "  IP:       $IP"
echo "  Memory:   ${MEMORY}MB  Cores: ${CORES}  Disk: ${DISK}GB"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Download template if needed
if ! pveam list "$TEMPLATE_STORE" | grep -q "$TEMPLATE"; then
  echo "[*] Downloading Ubuntu 22.04 template…"
  pveam update
  pveam download "$TEMPLATE_STORE" "$TEMPLATE"
fi

# Build network string
if [ "$IP" = "dhcp" ]; then
  NET_STR="ip=dhcp"
else
  NET_STR="ip=${IP}${GW:+,gw=$GW}"
fi

# Create container
pct create "$VMID" "${TEMPLATE_STORE}:vztmpl/${TEMPLATE}" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "name=eth0,bridge=vmbr0,${NET_STR}" \
  --unprivileged 1 \
  --features nesting=1 \
  --start 1 \
  --onboot 1

echo "[*] Waiting for container to start…"
sleep 5

# Push repo into container and run setup
echo "[*] Copying WebCameras into container…"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tar -czf /tmp/webcameras.tar.gz -C "$(dirname "$SCRIPT_DIR")" "$(basename "$SCRIPT_DIR")"
pct push "$VMID" /tmp/webcameras.tar.gz /tmp/webcameras.tar.gz
rm /tmp/webcameras.tar.gz

echo "[*] Running setup inside container…"
pct exec "$VMID" -- bash -c "
  cd /tmp
  tar -xzf webcameras.tar.gz
  cd webcameras
  bash scripts/setup-lxc.sh
  rm -rf /tmp/webcameras /tmp/webcameras.tar.gz
"

CONTAINER_IP=$(pct exec "$VMID" -- hostname -I | awk '{print $1}')
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ Container ready!"
echo "  Access: http://${CONTAINER_IP}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
