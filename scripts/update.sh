#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  WebCameras Update Script                                   ║
# ║  Version: 2026.07.01                                        ║
# ║  Run as root inside the LXC container: update               ║
# ╚══════════════════════════════════════════════════════════════╝

INSTALL_DIR="/opt/webcameras"
CONFIG_DIR="/etc/webcameras"
REPO_URL="https://github.com/Wyofarr/WebCameras"
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

# ─── Ensure git is installed ──────────────────────────────────
if ! command -v git &>/dev/null; then
  echo -e "${YELLOW}Installing git…${NC}"
  apt-get install -y git -qq
fi

# ─── Check internet ───────────────────────────────────────────
echo -n "  Checking internet connection… "
if ! curl -s --max-time 5 https://github.com > /dev/null 2>&1; then
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

# ─── Get latest version from GitHub (public repo, no auth) ───
echo -n "  Fetching latest version from GitHub… "

# Extract owner/repo from URL
REPO_PATH=$(echo "$REPO_URL" | sed 's|https://github.com/||' | sed 's|\.git$||' | sed 's|/$||')

# Try GitHub releases API first (no auth required for public repos)
LATEST_JSON=$(curl -s --max-time 10 \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${REPO_PATH}/releases/latest" 2>/dev/null)

LATEST_VERSION=$(echo "$LATEST_JSON" | grep '"tag_name"' | \
  sed 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/')

# Fall back to reading package.json from main branch if no releases exist
if [ -z "$LATEST_VERSION" ] || echo "$LATEST_VERSION" | grep -q "Not Found\|message"; then
  LATEST_VERSION=$(curl -s --max-time 10 \
    "https://raw.githubusercontent.com/${REPO_PATH}/main/package.json" 2>/dev/null \
    | grep '"version"' | sed 's/.*"version": *"\([^"]*\)".*/\1/')
fi

if [ -z "$LATEST_VERSION" ]; then
  echo -e "${YELLOW}Could not determine — repo may have no releases yet${NC}"
  LATEST_VERSION="unknown"
else
  echo -e "${GREEN}${LATEST_VERSION}${NC}"
fi

# ─── Show version status ──────────────────────────────────────
echo ""
echo -e "  ${BOLD}Installed version:${NC} ${LOCAL_VERSION}"
echo -e "  ${BOLD}Latest version:   ${NC} ${LATEST_VERSION}"
echo -e "  ${BOLD}Repository:       ${NC} ${REPO_URL}"
echo ""

# ─── Confirm upgrade ──────────────────────────────────────────
if [ "$LOCAL_VERSION" = "$LATEST_VERSION" ] && [ "$LATEST_VERSION" != "unknown" ]; then
  echo -e "  ${GREEN}✓ You are already running the latest version (${LOCAL_VERSION})${NC}"
  echo ""
  read -r -p "  Reinstall anyway? [y/N] " force
  if [[ ! "$force" =~ ^[Yy]$ ]]; then
    echo "  Cancelled."
    exit 0
  fi
else
  if [ "$LATEST_VERSION" = "unknown" ]; then
    echo -e "  ${YELLOW}⚠ Could not verify the latest version from GitHub.${NC}"
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
echo "[$(date)] Update started: ${LOCAL_VERSION} → ${LATEST_VERSION}" >> "$LOG"

# ─── Backup config ────────────────────────────────────────────
echo -n "  Backing up config… "
BACKUP_DIR="/etc/webcameras-backup-$(date +%Y%m%d-%H%M%S)"
cp -r "$CONFIG_DIR" "$BACKUP_DIR" 2>/dev/null && \
  echo -e "${GREEN}OK${NC} (${BACKUP_DIR})" || \
  echo -e "${YELLOW}SKIPPED${NC}"

# ─── Clone — try public (no auth), prompt only if it fails ───
echo -n "  Downloading latest version… "
rm -rf "$TMP_DIR"

# First attempt: public clone, no credentials, quiet
GIT_TERMINAL_PROMPT=0 git clone --depth=1 "$REPO_URL" "$TMP_DIR" >> "$LOG" 2>&1

if [ $? -ne 0 ]; then
  echo -e "${YELLOW}public clone failed${NC}"
  echo ""
  echo -e "  ${YELLOW}The repository may be private or require authentication.${NC}"
  echo -e "  Enter your GitHub credentials, or press Ctrl+C to cancel."
  echo ""

  read -r -p "  GitHub username: " GH_USER
  read -r -s -p "  GitHub token (or password): " GH_TOKEN
  echo ""

  # Build authenticated URL
  AUTH_URL="https://${GH_USER}:${GH_TOKEN}@github.com/${REPO_PATH}.git"

  rm -rf "$TMP_DIR"
  GIT_TERMINAL_PROMPT=0 git clone --depth=1 "$AUTH_URL" "$TMP_DIR" >> "$LOG" 2>&1

  if [ $? -ne 0 ]; then
    echo -e "  ${RED}FAILED — could not clone repository${NC}"
    echo -e "  Check your credentials or that the repo URL is correct:"
    echo -e "  ${CYAN}${REPO_URL}${NC}"
    echo -e "  Full log: ${LOG}"
    exit 1
  fi
fi

echo -e "${GREEN}OK${NC}"

# ─── Stop service ─────────────────────────────────────────────
echo -n "  Stopping WebCameras… "
systemctl stop webcameras 2>/dev/null
rm -rf /tmp/webcameras/hls/* 2>/dev/null
echo -e "${GREEN}OK${NC}"

# ─── Install new files ────────────────────────────────────────
echo -n "  Installing new files… "
cp -r "$TMP_DIR/server"       "$INSTALL_DIR/" >> "$LOG" 2>&1
cp -r "$TMP_DIR/public"       "$INSTALL_DIR/" >> "$LOG" 2>&1
cp    "$TMP_DIR/package.json" "$INSTALL_DIR/" >> "$LOG" 2>&1
[ -d "$TMP_DIR/scripts" ] && cp -r "$TMP_DIR/scripts" "$INSTALL_DIR/" >> "$LOG" 2>&1
echo -e "${GREEN}OK${NC}"

# ─── Update npm dependencies ─────────────────────────────────
echo -n "  Updating dependencies… "
cd "$INSTALL_DIR" && npm install --production --silent >> "$LOG" 2>&1 && \
  echo -e "${GREEN}OK${NC}" || echo -e "${YELLOW}WARN (check $LOG)${NC}"

# ─── Restore user config (never overwrite) ───────────────────
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

# ─── Fix LXC-incompatible systemd options if present ─────────
echo -n "  Checking service file… "
if grep -q "PrivateTmp\|ProtectSystem\|NoNewPrivileges" \
    /etc/systemd/system/webcameras.service 2>/dev/null; then
  sed -i '/^NoNewPrivileges/d;/^PrivateTmp/d;/^ProtectSystem/d;/^ReadWritePaths/d' \
    /etc/systemd/system/webcameras.service
  echo -e "${YELLOW}Fixed LXC incompatible sandbox options${NC}"
else
  echo -e "${GREEN}OK${NC}"
fi

# ─── Cleanup ─────────────────────────────────────────────────
rm -rf "$TMP_DIR"

# ─── Restart ─────────────────────────────────────────────────
echo -n "  Restarting WebCameras… "
systemctl daemon-reload
systemctl start webcameras
sleep 3

if systemctl is-active --quiet webcameras; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAILED${NC}"
  echo -e "  Check: ${CYAN}journalctl -u webcameras -n 30${NC}"
  exit 1
fi

# ─── Done ────────────────────────────────────────────────────
NEW_VERSION=$(node -e \
  "console.log(require('$INSTALL_DIR/package.json').version)" 2>/dev/null \
  || echo "$LATEST_VERSION")

echo "[$(date)] Update complete: ${NEW_VERSION}" >> "$LOG"

IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "  ${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "  ${GREEN}║  Update complete! Now running ${NEW_VERSION}  ║${NC}"
echo -e "  ${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Web UI:   ${CYAN}http://${IP}${NC}"
echo -e "  Config:   ${CYAN}http://${IP}/config${NC}"
echo -e "  Backup:   ${BACKUP_DIR}"
echo -e "  Log:      ${LOG}"
echo ""
