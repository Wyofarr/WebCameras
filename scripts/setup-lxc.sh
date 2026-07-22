#!/bin/bash
# ------------------------------------------------------------
# -  WebCameras - LXC Container Setup Script                -
# -  Ubuntu 22.04 LTS base image                           -
# -  Run as root inside the container                       -
# ------------------------------------------------------------
set -e

INSTALL_DIR="/opt/webcameras"
SERVICE_USER="webcameras"
PORT="${PORT:-8080}"
CONFIG_DIR="/etc/webcameras"
HLS_DIR="/var/lib/webcameras/hls"
LOG_DIR="/var/log/webcameras"

echo "---------------------------------------------"
echo "  WebCameras LXC Setup"
echo "---------------------------------------------"

# --- System packages --------------------------------------
echo "[1/6] Installing system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  curl wget gnupg ca-certificates \
  ffmpeg nginx git lsof \
  2>/dev/null

# --- Node.js 20 LTS ---------------------------------------
echo "[2/6] Installing Node.js 20 LTS..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>/dev/null
  apt-get install -y nodejs 2>/dev/null
fi
echo "  Node: $(node --version)  NPM: $(npm --version)"

# --- Service user -----------------------------------------
echo "[3/6] Creating service user..."
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd -r -s /bin/false -d "$INSTALL_DIR" "$SERVICE_USER"
fi

# --- Install application ----------------------------------
echo "[4/6] Installing WebCameras..."
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$LOG_DIR" "$HLS_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cp -r "$REPO_DIR/server"     "$INSTALL_DIR/"
cp -r "$REPO_DIR/public"     "$INSTALL_DIR/"
cp -r "$REPO_DIR/scripts"    "$INSTALL_DIR/"
cp    "$REPO_DIR/package.json" "$INSTALL_DIR/"

# Ensure fallback config dir exists inside install dir
mkdir -p "$INSTALL_DIR/config"

cd "$INSTALL_DIR"
npm install --production --silent

# Copy default configs only if not already present
for f in "$REPO_DIR/config/"*; do
  dest="$CONFIG_DIR/$(basename "$f")"
  [ -f "$dest" ] || cp "$f" "$dest"
done

chown -R "$SERVICE_USER:$SERVICE_USER" \
  "$INSTALL_DIR" "$CONFIG_DIR" "$LOG_DIR" "$HLS_DIR"

# --- Systemd service --------------------------------------
echo "[5/6] Writing systemd service..."

# Always write a clean service file - no sandbox options (incompatible with LXC)
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
ExecStart=/usr/bin/node ${INSTALL_DIR}/server/index.js
Restart=always
RestartSec=5
StandardOutput=append:${LOG_DIR}/app.log
StandardError=append:${LOG_DIR}/error.log

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable webcameras
systemctl restart webcameras

# --- Nginx reverse proxy ----------------------------------
echo "[6/6] Configuring Nginx..."
cat > /etc/nginx/sites-available/webcameras << NGXEOF
gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 6;
gzip_types text/plain text/css text/xml text/javascript
           application/javascript application/json application/x-mpegURL;

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";

    location /socket.io/ {
        proxy_pass         http://127.0.0.1:${PORT}/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 86400s;
    }

    location /hls/ {
        proxy_pass         http://127.0.0.1:${PORT}/hls/;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        add_header         Cache-Control "no-cache, no-store, must-revalidate";
        add_header         Access-Control-Allow-Origin "*";
    }

    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
        client_max_body_size 10m;
    }
}
NGXEOF

ln -sf /etc/nginx/sites-available/webcameras /etc/nginx/sites-enabled/webcameras
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl enable nginx && systemctl restart nginx

# --- Install update command --------------------------------
echo "[+] Installing 'update' command..."
cp "$SCRIPT_DIR/update.sh" /usr/local/bin/update
chmod +x /usr/local/bin/update

# --- Done -------------------------------------------------
IP=$(hostname -I | awk '{print $1}')
echo ""
echo "---------------------------------------------"
echo "  OK WebCameras installed successfully!"
echo ""
echo "  Web UI:  http://${IP}"
echo "  Config:  http://${IP}/config"
echo "  Update:  type 'update' to upgrade"
echo "  Logs:    tail -f ${LOG_DIR}/app.log"
echo "  Status:  systemctl status webcameras"
echo "---------------------------------------------"
