#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  WebCameras Update Script                                   ║
# ║  Version: 2026.07.01                                  ║
# ║  Run as root inside the LXC container: update               ║
# ╚══════════════════════════════════════════════════════════════╝

INSTALL_DIR="/opt/webcameras"
CONFIG_DIR="/etc/webcameras"
REPO_URL="https://github.com/YOURUSER/webcameras.git"
TMP_DIR="/tmp/webcameras-update"
LOG="/var/log/webcameras/update.log"

# ─── Colours ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

echo -e "${CYAN}"
echo "  ╔══════════════════════════════════════╗"
echo "  ║       WebCameras Updater             ║"
echo "  ╚══════════════════════════════════════╝"
echo -e "${NC}"

# ─── Check root ───────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Error: Please run as root${NC}"
  exit 1
fi

# ─── Check git ────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  echo -e "${YELLOW}Installing git…${NC}"
  apt-get install -y git -qq
fi

# ─── Check internet ───────────────────────────────────────────
echo -n "  Checking internet connection… "
if ! curl -s --max-time 5 https://api.github.com > /dev/null 2>&1; then
  echo -e "${RED}FAILED${NC}"
  echo -e "${RED}Cannot reach GitHub. Check your network connection.${NC}"
  exit 1
fi
echo -e "${GREEN}OK${NC}"

# ─── Get local version ────────────────────────────────────────
LOCAL_VERSION="unknown"
if [ -f "$INSTALL_DIR/package.json" ]; then
  LOCAL_VERSION=$(node -e "console.log(require('$INSTALL_DIR/package.json').version)" 2>/dev/null || echo "unknown")
fi

# ─── Get latest version from GitHub ──────────────────────────
echo -n "  Fetching latest version from GitHub… "
REPO_PATH=$(echo "$REPO_URL" | sed 's|https://github.com/||' | sed 's|\.git||')
LATEST_JSON=$(curl -s --max-time 10 "https://api.github.com/repos/${REPO_PATH}/releases/latest" 2>/dev/null)
LATEST_VERSION=$(echo "$LATEST_JSON" | grep '"tag_name"' | sed 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/')

if [ -z "$LATEST_VERSION" ]; then
  # No releases found — fall back to reading package.json from main branch
  LATEST_VERSION=$(curl -s --max-time 10 \
    "https://raw.githubusercontent.com/${REPO_PATH}/main/package.json" 2>/dev/null \
    | grep '"version"' | sed 's/.*"version": *"\([^"]*\)".*/\1/')
fi

if [ -z "$LATEST_VERSION" ]; then
  echo -e "${YELLOW}Could not determine latest version${NC}"
  LATEST_VERSION="unknown"
else
  echo -e "${GREEN}v${LATEST_VERSION}${NC}"
fi

echo ""
echo -e "  ${BOLD}Installed version:${NC} v${LOCAL_VERSION}"
echo -e "  ${BOLD}Latest version:   ${NC} v${LATEST_VERSION}"
echo ""

# ─── Version comparison ───────────────────────────────────────
if [ "$LOCAL_VERSION" = "$LATEST_VERSION" ] && [ "$LATEST_VERSION" != "unknown" ]; then
  echo -e "  ${GREEN}✓ You are already running the latest version (v${LOCAL_VERSION})${NC}"
  echo ""
  read -r -p "  Reinstall anyway? [y/N] " force
  if [[ ! "$force" =~ ^[Yy]$ ]]; then
    echo "  Cancelled."
    exit 0
  fi
else
  if [ "$LATEST_VERSION" = "unknown" ]; then
    echo -e "  ${YELLOW}⚠ Could not verify latest version.${NC}"
    read -r -p "  Continue with update anyway? [y/N] " confirm
  else
    echo -e "  ${YELLOW}You are currently running version ${LOCAL_VERSION} of WebCameras"
    echo -e "  and version ${LATEST_VERSION} is available.${NC}"
    echo ""
    read -r -p "  Are you sure you want to upgrade? [y/N] " confirm
  fi
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "  Cancelled."
    exit 0
  fi
fi

echo ""
echo -e "  ${CYAN}Starting update…${NC}"
mkdir -p "$(dirname $LOG)"
echo "[$(date)] Update started: v${LOCAL_VERSION} → v${LATEST_VERSION}" >> "$LOG"

# ─── Backup config ────────────────────────────────────────────
echo -n "  Backing up config… "
BACKUP_DIR="/etc/webcameras-backup-$(date +%Y%m%d-%H%M%S)"
cp -r "$CONFIG_DIR" "$BACKUP_DIR" 2>/dev/null && \
  echo -e "${GREEN}OK${NC} (${BACKUP_DIR})" || \
  echo -e "${YELLOW}SKIPPED (no config found)${NC}"

# ─── Clone latest ─────────────────────────────────────────────
echo -n "  Downloading latest version… "
rm -rf "$TMP_DIR"
if git clone --depth=1 "$REPO_URL" "$TMP_DIR" >> "$LOG" 2>&1; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAILED${NC}"
  echo -e "${RED}Could not clone repository. Check REPO_URL in this script.${NC}"
  echo -e "  Current URL: ${REPO_URL}"
  echo -e "  Edit with: ${CYAN}nano /usr/local/bin/update${NC}"
  exit 1
fi

# ─── Stop service ─────────────────────────────────────────────
echo -n "  Stopping WebCameras service… "
systemctl stop webcameras 2>/dev/null
rm -rf /tmp/webcameras/hls/* 2>/dev/null
echo -e "${GREEN}OK${NC}"

# ─── Install new files ────────────────────────────────────────
echo -n "  Installing new files… "
cp -r "$TMP_DIR/server"  "$INSTALL_DIR/" >> "$LOG" 2>&1
cp -r "$TMP_DIR/public"  "$INSTALL_DIR/" >> "$LOG" 2>&1
cp    "$TMP_DIR/package.json" "$INSTALL_DIR/" >> "$LOG" 2>&1
cp -r "$TMP_DIR/scripts" "$INSTALL_DIR/" >> "$LOG" 2>&1
echo -e "${GREEN}OK${NC}"

# ─── Install new npm dependencies ────────────────────────────
echo -n "  Updating dependencies… "
cd "$INSTALL_DIR" && npm install --production --silent >> "$LOG" 2>&1 && \
  echo -e "${GREEN}OK${NC}" || echo -e "${YELLOW}WARN (check $LOG)${NC}"

# ─── Restore config (never overwrite user config) ────────────
echo -n "  Restoring your config… "
cp -rn "$BACKUP_DIR/." "$CONFIG_DIR/" 2>/dev/null
echo -e "${GREEN}OK${NC}"

# ─── Fix permissions ─────────────────────────────────────────
chown -R webcameras:webcameras "$INSTALL_DIR" "$CONFIG_DIR" \
  /var/log/webcameras /tmp/webcameras 2>/dev/null

# ─── Update this script itself ───────────────────────────────
if [ -f "$TMP_DIR/scripts/update.sh" ]; then
  cp "$TMP_DIR/scripts/update.sh" /usr/local/bin/update
  chmod +x /usr/local/bin/update
fi

# ─── Check service file (fix LXC namespace issue) ────────────
echo -n "  Checking service file… "
if grep -q "PrivateTmp\|ProtectSystem\|NoNewPrivileges" /etc/systemd/system/webcameras.service 2>/dev/null; then
  sed -i '/^NoNewPrivileges/d;/^PrivateTmp/d;/^ProtectSystem/d;/^ReadWritePaths/d' \
    /etc/systemd/system/webcameras.service
  echo -e "${YELLOW}Fixed LXC incompatible options${NC}"
else
  echo -e "${GREEN}OK${NC}"
fi

# ─── Cleanup ─────────────────────────────────────────────────
rm -rf "$TMP_DIR"

# ─── Reload and restart ──────────────────────────────────────
echo -n "  Restarting WebCameras… "
systemctl daemon-reload
systemctl start webcameras

# Wait and check
sleep 3
if systemctl is-active --quiet webcameras; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAILED — check: journalctl -u webcameras -n 30${NC}"
  exit 1
fi

# ─── Get new version ─────────────────────────────────────────
NEW_VERSION=$(node -e "console.log(require('$INSTALL_DIR/package.json').version)" 2>/dev/null || echo "$LATEST_VERSION")
echo "[$(date)] Update complete: v${NEW_VERSION}" >> "$LOG"

# ─── Done ────────────────────────────────────────────────────
CONTAINER_IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "  ${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "  ${GREEN}║  Update complete! Now running v${NEW_VERSION}  ║${NC}"
echo -e "  ${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Web UI:   ${CYAN}http://${CONTAINER_IP}${NC}"
echo -e "  Config:   ${CYAN}http://${CONTAINER_IP}/config${NC}"
echo -e "  Backup:   ${BACKUP_DIR}"
echo -e "  Log:      ${LOG}"
echo ""
