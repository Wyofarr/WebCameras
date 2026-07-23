#!/bin/bash
# ----------------------------------------------------------------
# -  WebCameras Update Script                                   -
# -  Version: 2026.07.06                                        -
# -  Run as root inside the LXC container: update               -
# ----------------------------------------------------------------

INSTALL_DIR="/opt/webcameras"
CONFIG_DIR="/etc/webcameras"
HLS_DIR="/var/lib/webcameras/hls"
PID_DIR="/var/lib/webcameras/pids"
LOG_DIR="/var/log/webcameras"
SERVICE_USER="webcameras"
PORT="${PORT:-8080}"
REPO_URL="https://github.com/Wyofarr/WebCameras"
TMP_DIR="/tmp/webcameras-update"
LOG="${LOG_DIR}/update.log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

echo -e "${CYAN}"
echo "  +======================================+"
echo "  |       WebCameras Updater             |"
echo "  +======================================+"
echo -e "${NC}"

# --------------------------------------------------
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Error: Please run as root${NC}"
  exit 1
fi

# --------------------------------------------------
for tool in git curl node npm lsof; do
  if ! command -v "$tool" &>/dev/null; then
    echo -e "  ${YELLOW}Installing missing tool: $tool${NC}"
    apt-get install -y "$tool" -qq 2>/dev/null || true
  fi
done

# --------------------------------------------------
echo -n "  Checking internet connection? "
if ! curl -s --max-time 5 https://github.com > /dev/null 2>&1; then
  echo -e "${RED}FAILED${NC}"
  echo -e "${RED}Cannot reach GitHub. Check network/IP forwarding.${NC}"
  exit 1
fi
echo -e "${GREEN}OK${NC}"

# --------------------------------------------------
LOCAL_VERSION="unknown"
if [ -f "$INSTALL_DIR/package.json" ]; then
  LOCAL_VERSION=$(node -e \
    "console.log(require('$INSTALL_DIR/package.json').version)" 2>/dev/null \
    || echo "unknown")
fi

# --------------------------------------------------
echo -n "  Fetching latest version from GitHub? "
REPO_PATH=$(echo "$REPO_URL" | sed 's|https://github.com/||;s|\.git$||;s|/$||')

LATEST_VERSION=$(curl -s --max-time 10 \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${REPO_PATH}/releases/latest" 2>/dev/null \
  | grep '"tag_name"' \
  | sed 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/')

if [ -z "$LATEST_VERSION" ] || echo "$LATEST_VERSION" | grep -q "Not Found\|message"; then
  LATEST_VERSION=$(curl -s --max-time 10 \
    "https://raw.githubusercontent.com/${REPO_PATH}/main/package.json" 2>/dev/null \
    | grep '"version"' | sed 's/.*"version": *"\([^"]*\)".*/\1/')
fi

[ -z "$LATEST_VERSION" ] \
  && { echo -e "${YELLOW}Could not determine${NC}"; LATEST_VERSION="unknown"; } \
  || echo -e "${GREEN}${LATEST_VERSION}${NC}"

echo ""
echo -e "  ${BOLD}Installed version:${NC} ${LOCAL_VERSION}"
echo -e "  ${BOLD}Latest version:   ${NC} ${LATEST_VERSION}"
echo -e "  ${BOLD}Repository:       ${NC} ${REPO_URL}"
echo ""

# --------------------------------------------------
if [ "$LOCAL_VERSION" = "$LATEST_VERSION" ] && [ "$LATEST_VERSION" != "unknown" ]; then
  echo -e "  ${GREEN}OK Already running the latest version (${LOCAL_VERSION})${NC}"
  echo ""
  read -r -p "  Reinstall anyway? [y/N] " force
  [[ "$force" =~ ^[Yy]$ ]] || { echo "  Cancelled."; exit 0; }
else
  if [ "$LATEST_VERSION" = "unknown" ]; then
    echo -e "  ${YELLOW}! Could not verify latest version from GitHub.${NC}"
    read -r -p "  Continue anyway? [y/N] " confirm
  else
    echo -e "  ${YELLOW}You are currently running version ${LOCAL_VERSION} of WebCameras"
    echo -e "  and version ${LATEST_VERSION} is available.${NC}"
    echo ""
    read -r -p "  Are you sure you want to upgrade? [y/N] " confirm
  fi
  [[ "$confirm" =~ ^[Yy]$ ]] || { echo "  Cancelled."; exit 0; }
fi

echo ""
echo -e "  ${CYAN}Starting update?${NC}"
mkdir -p "$LOG_DIR"
echo "[$(date)] Update started: ${LOCAL_VERSION} -> ${LATEST_VERSION}" >> "$LOG"

# --------------------------------------------------
echo -n "  Backing up config? "
BACKUP_DIR="/etc/webcameras-backup-$(date +%Y%m%d-%H%M%S)"
cp -r "$CONFIG_DIR" "$BACKUP_DIR" 2>/dev/null \
  && echo -e "${GREEN}OK${NC} (${BACKUP_DIR})" \
  || echo -e "${YELLOW}SKIPPED${NC}"

# --------------------------------------------------
echo -n "  Downloading latest version? "
rm -rf "$TMP_DIR"

GIT_TERMINAL_PROMPT=0 git clone --depth=1 "$REPO_URL" "$TMP_DIR" >> "$LOG" 2>&1

if [ $? -ne 0 ]; then
  echo -e "${YELLOW}public clone failed ? trying with credentials${NC}"
  read -r -p "  GitHub username: " GH_USER
  read -r -s -p "  GitHub token: " GH_TOKEN
  echo ""
  rm -rf "$TMP_DIR"
  GIT_TERMINAL_PROMPT=0 git clone --depth=1 \
    "https://${GH_USER}:${GH_TOKEN}@github.com/${REPO_PATH}.git" \
    "$TMP_DIR" >> "$LOG" 2>&1
  if [ $? -ne 0 ]; then
    echo -e "  ${RED}FAILED ? check credentials and repo URL${NC}"
    exit 1
  fi
fi
echo -e "${GREEN}OK${NC}"

# --------------------------------------------------
echo -n "  Stopping WebCameras? "
systemctl stop webcameras 2>/dev/null || true
sleep 2
pkill -9 ffmpeg 2>/dev/null || true
pkill -f 'node.*server/index.js' 2>/dev/null || true
sleep 1
echo -e "${GREEN}OK${NC}"

# --------------------------------------------------
echo -n "  Installing new files? "
cp -r "$TMP_DIR/server"       "$INSTALL_DIR/" >> "$LOG" 2>&1
cp -r "$TMP_DIR/public"       "$INSTALL_DIR/" >> "$LOG" 2>&1
cp -r "$TMP_DIR/scripts"      "$INSTALL_DIR/" >> "$LOG" 2>&1
cp    "$TMP_DIR/package.json" "$INSTALL_DIR/" >> "$LOG" 2>&1

# Ensure fallback config dir exists (prevents scandir error on startup)
mkdir -p "$INSTALL_DIR/config"
for f in "$TMP_DIR/config/"*; do
  dest="$INSTALL_DIR/config/$(basename "$f")"
  [ -f "$dest" ] || cp "$f" "$dest" 2>/dev/null || true
done
echo -e "${GREEN}OK${NC}"

# --------------------------------------------------
echo -n "  Updating dependencies? "
cd "$INSTALL_DIR" && npm install --production --silent >> "$LOG" 2>&1 \
  && echo -e "${GREEN}OK${NC}" \
  || echo -e "${YELLOW}WARN ? check $LOG${NC}"

# --------------------------------------------------
echo -n "  Restoring your config? "
cp -rn "$BACKUP_DIR/." "$CONFIG_DIR/" 2>/dev/null || true
echo -e "${GREEN}OK${NC}"

# --------------------------------------------------
echo -n "  Ensuring HLS directory? "
mkdir -p "$HLS_DIR" "$PID_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" \
  "$INSTALL_DIR" "$CONFIG_DIR" "$LOG_DIR" "$HLS_DIR" "$PID_DIR" 2>/dev/null || true
echo -e "${GREEN}OK${NC}"

# --------------------------------------------------
# This fixes: 226/NAMESPACE, missing HLS_DIR, wrong paths
echo -n "  Writing service file? "
cat > /etc/systemd/system/webcameras.service << SVCEOF
[Unit]
Description=WebCameras ? Web IP Camera Display
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=CONFIG_PATH=${CONFIG_DIR}
Environment=HLS_DIR=${HLS_DIR}
Environment=PID_DIR=${PID_DIR}
ExecStart=/usr/bin/node ${INSTALL_DIR}/server/index.js
Restart=always
RestartSec=5
StandardOutput=append:${LOG_DIR}/app.log
StandardError=append:${LOG_DIR}/error.log

[Install]
WantedBy=multi-user.target
SVCEOF
echo -e "${GREEN}OK${NC}"

# --------------------------------------------------
if [ -f "$TMP_DIR/scripts/update.sh" ]; then
  cp "$TMP_DIR/scripts/update.sh" /usr/local/bin/update
  chmod +x /usr/local/bin/update
fi

# --------------------------------------------------
rm -rf "$TMP_DIR"

# --------------------------------------------------
echo -n "  Restarting WebCameras? "
systemctl daemon-reload
systemctl enable webcameras 2>/dev/null || true
systemctl start webcameras
sleep 4

if systemctl is-active --quiet webcameras; then
  echo -e "${GREEN}OK${NC}"
else
  # Show the actual error before giving up
  echo -e "${RED}FAILED${NC}"
  echo ""
  echo -e "  ${YELLOW}Node.js error:${NC}"
  sudo -u "$SERVICE_USER" node "$INSTALL_DIR/server/index.js" 2>&1 | head -10 \
    || node "$INSTALL_DIR/server/index.js" 2>&1 | head -10
  echo ""
  echo -e "  ${YELLOW}Service log:${NC}"
  journalctl -u webcameras -n 10 --no-pager 2>/dev/null || true
  echo ""
  echo -e "  Full log: ${CYAN}${LOG}${NC}"
  exit 1
fi

# --------------------------------------------------
NEW_VERSION=$(node -e \
  "console.log(require('$INSTALL_DIR/package.json').version)" 2>/dev/null \
  || echo "$LATEST_VERSION")

echo "[$(date)] Update complete: ${NEW_VERSION}" >> "$LOG"

IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "  ${GREEN}+==============================================+${NC}"
echo -e "  ${GREEN}|  Update complete!  Now running ${NEW_VERSION}    |${NC}"
echo -e "  ${GREEN}+==============================================+${NC}"
echo ""
echo -e "  Web UI:   ${CYAN}http://${IP}${NC}"
echo -e "  Config:   ${CYAN}http://${IP}/config${NC}"
echo -e "  Backup:   ${BACKUP_DIR}"
echo -e "  Log:      ${LOG}"
echo ""
