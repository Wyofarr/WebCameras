# WebCameras

Web-based IP camera display system — browser replacement for [displaycameras](https://github.com/Anonymousdog/displaycameras).

Streams RTSP/MJPEG/HLS feeds to any HTML5 browser via server-side HLS transcoding (ffmpeg). Designed to run in an **LXC container** (Proxmox) or Docker, accessible from any device on your network.

---

## Features

- **HTML5 browser UI** — no HDMI, no monitor, no X11 required
- **Custom layouts** — position/size each camera window as a ratio (0.0–1.0) of the viewport
- **Multiple layout pages** — tab between views, or auto-rotate on a timer
- **Live layout editor** — drag windows in the preview, assign cameras, save instantly
- **HLS streaming** — ffmpeg transcodes RTSP → HLS; HLS.js plays in the browser
- **MJPEG + direct HLS** — also supports cameras with native HTTP/MJPEG feeds
- **Socket.IO live updates** — config changes propagate to all open browser tabs instantly
- **LXC / Docker ready** — single setup script installs everything

---

## Quick Start

### Option A — Proxmox LXC (recommended)

```bash
# On your Proxmox HOST:
git clone https://github.com/yourname/webcameras
cd webcameras

# Creates container ID 200, hostname webcameras, DHCP IP
bash scripts/create-lxc.sh

# Or with a static IP:
bash scripts/create-lxc.sh 200 webcameras 192.168.1.200/24 192.168.1.1
```

### Option B — Existing LXC / Ubuntu VM

```bash
git clone https://github.com/yourname/webcameras
cd webcameras
sudo bash scripts/setup-lxc.sh
```

### Option C — Docker

```bash
git clone https://github.com/yourname/webcameras
cd webcameras
docker compose up -d
```

After installation, open **http://\<container-ip\>** in your browser.

---

## Configuration

All config lives in `/etc/webcameras/` (or `./config/` in dev).

### Main config — `webcameras.conf.json`

```json
{
  "title":       "WebCameras",
  "rotate":      false,
  "rotatedelay": 30,
  "startsleep":  2,
  "feedsleep":   2,
  "retry":       3
}
```

| Field | Description |
|-------|-------------|
| `title` | Browser tab / app title |
| `rotate` | Auto-cycle through layout pages |
| `rotatedelay` | Seconds between page rotations |
| `startsleep` | Seconds to wait before starting streams |
| `feedsleep` | Delay between starting individual feeds |
| `retry` | HLS error retry attempts |

---

### Layout pages — `layout.<name>.json`

Each file is one "page" (tab). Name the file `layout.main.json`, `layout.outdoor.json`, etc.

```json
{
  "label": "Main View",
  "cameras": [
    {
      "id":        "front-door",
      "label":     "Front Door",
      "url":       "rtsp://192.168.1.100:554/stream1",
      "transport": "tcp",
      "type":      "rtsp"
    }
  ],
  "windows": [
    {
      "id":       "w1",
      "cameraId": "front-door",
      "label":    "Front Door",
      "x":        0.0,
      "y":        0.0,
      "w":        0.5,
      "h":        0.5
    }
  ]
}
```

#### Window position fields

All values are **fractions of the viewport** (0.0 to 1.0):

| Field | Meaning |
|-------|---------|
| `x` | Left edge (0 = left side of screen, 1 = right side) |
| `y` | Top edge  (0 = top of screen, 1 = bottom) |
| `w` | Width  (0.5 = half the screen wide) |
| `h` | Height (0.5 = half the screen tall) |

#### Examples

**4-up quad:**
```json
"windows": [
  { "id":"w1", "x":0,   "y":0,   "w":0.5, "h":0.5, "cameraId":"cam1" },
  { "id":"w2", "x":0.5, "y":0,   "w":0.5, "h":0.5, "cameraId":"cam2" },
  { "id":"w3", "x":0,   "y":0.5, "w":0.5, "h":0.5, "cameraId":"cam3" },
  { "id":"w4", "x":0.5, "y":0.5, "w":0.5, "h":0.5, "cameraId":"cam4" }
]
```

**Featured (1 large + 3 side-by-side right column):**
```json
"windows": [
  { "id":"w1", "x":0,     "y":0,     "w":0.667, "h":1,     "cameraId":"main-cam" },
  { "id":"w2", "x":0.667, "y":0,     "w":0.333, "h":0.333, "cameraId":"cam2" },
  { "id":"w3", "x":0.667, "y":0.333, "w":0.333, "h":0.333, "cameraId":"cam3" },
  { "id":"w4", "x":0.667, "y":0.667, "w":0.333, "h":0.333, "cameraId":"cam4" }
]
```

**PiP (full screen + 3 small overlapping bottom-right):**
```json
"windows": [
  { "id":"w1", "x":0,    "y":0,    "w":1,    "h":1,    "cameraId":"main" },
  { "id":"w2", "x":0.68, "y":0.67, "w":0.32, "h":0.33, "cameraId":"pip1" },
  { "id":"w3", "x":0.34, "y":0.67, "w":0.32, "h":0.33, "cameraId":"pip2" },
  { "id":"w4", "x":0,    "y":0.67, "w":0.32, "h":0.33, "cameraId":"pip3" }
]
```

#### Camera `type` values

| Type | Description |
|------|-------------|
| `rtsp` | RTSP stream — server transcodes to HLS via ffmpeg |
| `hls` | Direct HLS `.m3u8` URL — played by HLS.js without transcoding |
| `mjpeg` | MJPEG HTTP stream — displayed as `<img>` tag |

---

## Stream Architecture

```
IP Camera (RTSP)
      │
      ▼
  ffmpeg (in container)
  rtsp → HLS segments (.ts) → /tmp/webcameras/hls/<id>/
      │
      ▼
  Express static /hls/
      │
      ▼
  HLS.js in browser  →  <video> element
```

For MJPEG cameras, the browser fetches the stream directly from the camera (no server transcoding).

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `→` | Next layout page |
| `←` | Previous layout page |
| `Esc` | Close fullscreen camera |
| `F` (fullscreen btn) | Toggle browser fullscreen |

---

## Logs & Management

```bash
# Service status
systemctl status webcameras

# Live logs
journalctl -u webcameras -f

# Restart
systemctl restart webcameras

# Config location
ls /etc/webcameras/
```

---

## LXC Container Specs

| Resource | Default |
|----------|---------|
| vCPUs | 2 |
| RAM | 512 MB |
| Disk | 8 GB |
| Base OS | Ubuntu 22.04 LTS |
| Port (internal) | 8080 |
| Port (Nginx) | 80 |

For many simultaneous RTSP streams, increase CPU cores. Each ffmpeg transcode process uses roughly 0.1–0.5 CPU cores depending on codec.

---

## API Reference

The Node.js server exposes a REST API (all used by the browser UI, but also scriptable):

```
GET    /api/config              — get global config
PUT    /api/config              — update global config

GET    /api/layouts             — list all layout pages
GET    /api/layouts/:name       — get one layout
PUT    /api/layouts/:name       — create/update layout
DELETE /api/layouts/:name       — delete layout

GET    /api/streams             — active stream status
POST   /api/streams/:id/start   — start HLS transcode  { url, transport }
POST   /api/streams/:id/stop    — stop HLS transcode
POST   /api/test-stream         — test camera connectivity { url, transport }
```

---

## Comparison with displaycameras

| Feature | displaycameras | webcameras |
|---------|---------------|------------|
| Display | HDMI / X11 | Web browser (HTML5) |
| Client | Raspberry Pi only | Any device with a browser |
| Layout config | Shell variable arrays | JSON ratio-based windows |
| Live editing | No | Yes (layout editor UI) |
| Multi-page | Yes (rotation) | Yes (tabs + rotation) |
| Protocol | omxplayer / vlc | HLS.js (RTSP → HLS) |
| Container | No | LXC + Docker |

---

## Troubleshooting

### 502 Bad Gateway / status=226/NAMESPACE

This happens because systemd sandboxing options (`PrivateTmp`, `ProtectSystem`, `NoNewPrivileges`) are not supported inside unprivileged LXC containers. The setup script already omits these, but if you see it on an older install:

```bash
nano /etc/systemd/system/webcameras.service
```

Remove these lines if present:
```
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=...
```

Then reload:
```bash
systemctl daemon-reload && systemctl restart webcameras
```

### Service won't start — check logs

```bash
systemctl status webcameras
tail -50 /var/log/webcameras/error.log

# Run manually to see errors directly in the terminal:
cd /opt/webcameras && node server/index.js
```

### node_modules missing

```bash
cd /opt/webcameras && npm install
systemctl restart webcameras
```

### Node.js not installed

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
systemctl restart webcameras
```

### pct exec / pct push giving sync_wait errors

Bypass pct entirely and use SSH or lxc-attach:

```bash
# Set root password from Proxmox host
lxc-attach -n <vmid> -- passwd root

# Then SSH into the container directly
ssh root@<container-ip>
```
