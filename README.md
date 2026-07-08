# WebCameras

**Version 2026.07.01**

Web-based IP camera display system — browser replacement for [displaycameras](https://github.com/Anonymousdog/displaycameras).

Streams RTSP/MJPEG/HLS feeds to any HTML5 browser via server-side HLS transcoding (ffmpeg). Designed to run in a **Proxmox LXC container**, accessible from any device on your network including phones and tablets.

---

## Features

- **HTML5 browser UI** — no HDMI, no monitor, no X11 required
- **HEVC/H.265 support** — 4K cameras transcoded to H.264 for browser playback
- **Black bar padding** — each camera window padded to exact viewport ratio
- **Custom layouts** — position/size each camera window as a 0.0–1.0 viewport fraction
- **Multiple layout pages** — tab between views, or auto-rotate on a timer
- **Default page** — choose which layout loads when opening the app
- **Live layout editor** — drag windows in the preview, assign cameras, save instantly
- **Username/password** — enter credentials separately from the URL
- **Per-camera settings** — resolution (480p/720p/1080p/4K) and bitrate per camera
- **Mobile-friendly** — bottom nav bar, touch targets, no iOS zoom on inputs
- **Config UI** — full web-based config at `/config` (no SSH needed for day-to-day changes)
- **About page** — shows version number, checks GitHub for updates
- **`update` command** — type `update` in the container to upgrade with version confirmation
- **Socket.IO live updates** — config changes propagate to all open browser tabs instantly

---

## Version Scheme

Versions follow `YEAR.MONTH.BUILD` format:
- `2026.07.01` = First build of July 2026
- `2026.07.02` = Second build of July 2026
- `2026.08.01` = First build of August 2026

---

## Quick Start

### Option A — Proxmox LXC (recommended)

```bash
# On your Proxmox HOST:
git clone https://github.com/YOURUSER/webcameras
cd webcameras
bash scripts/create-lxc.sh 200 webcameras 192.168.1.200/24 192.168.1.1
```

### Option B — Existing LXC / Ubuntu VM

```bash
git clone https://github.com/YOURUSER/webcameras
cd webcameras
sudo bash scripts/setup-lxc.sh
```

### Option C — Docker

```bash
git clone https://github.com/YOURUSER/webcameras
cd webcameras
docker compose up -d
```

Then open **http://\<container-ip\>** in your browser, or **http://\<container-ip\>/config** to configure cameras.

---

## Updating

From inside the LXC container as root:

```bash
update
```

Output:
```
  ╔══════════════════════════════════════╗
  ║       WebCameras Updater             ║
  ╚══════════════════════════════════════╝

  Checking internet connection… OK
  Fetching latest version from GitHub… 2026.08.01

  Installed version: 2026.07.01
  Latest version:    2026.08.01

  You are currently running version 2026.07.01 of WebCameras
  and version 2026.08.01 is available. Are you sure you want to upgrade? [y/N]
```

The update script:
- Backs up your config before updating
- Never overwrites your camera/layout config files
- Auto-fixes LXC-incompatible systemd sandbox options if they crept back in
- Updates itself on every run
- Restarts the service automatically

---

## Configuration

All config lives in `/etc/webcameras/` (or `./config/` for dev).

### Main config — `webcameras.conf.json`

```json
{
  "title":       "WebCameras",
  "defaultPage": "main",
  "rotate":      false,
  "rotatedelay": 30,
  "startsleep":  2,
  "feedsleep":   2,
  "retry":       3
}
```

### Layout pages — `layout.<name>.json`

```json
{
  "label": "Main View",
  "cameras": [
    {
      "id":         "front-door",
      "label":      "Front Door",
      "url":        "rtsp://192.168.1.100:554/stream1",
      "username":   "admin",
      "password":   "password",
      "transport":  "tcp",
      "type":       "rtsp",
      "resolution": "1080",
      "bitrate":    "2500"
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

#### Window position fields (0.0–1.0 viewport fractions)

| Field | Meaning |
|-------|---------|
| `x` | Left edge (0 = left, 1 = right) |
| `y` | Top edge (0 = top, 1 = bottom) |
| `w` | Width fraction (0.5 = half screen wide) |
| `h` | Height fraction (0.5 = half screen tall) |

#### Camera `resolution` values

| Value | Description |
|-------|-------------|
| `480` | 480p — minimal CPU |
| `720` | 720p — lower CPU |
| `1080` | 1080p — recommended (default) |
| `2160` | 4K — very high CPU |
| `source` | No transcode — H.264 cameras only |

---

## Stream Architecture

```
IP Camera (RTSP/H.265)
      │
      ▼
  ffmpeg (in LXC container)
  H.265 → H.264, scale + pad to window ratio
  → HLS segments (.ts) → /tmp/webcameras/hls/<id>/
      │
      ▼
  Express static /hls/
      │
      ▼
  HLS.js in browser → <video> element
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `→` | Next layout page |
| `←` | Previous layout page |
| `Esc` | Close fullscreen camera |
| Right-click tab | Set as default page |

---

## Troubleshooting

### 502 Bad Gateway / status=226/NAMESPACE

Systemd sandboxing options are incompatible with unprivileged LXC containers:

```bash
sed -i '/^NoNewPrivileges/d;/^PrivateTmp/d;/^ProtectSystem/d;/^ReadWritePaths/d' \
  /etc/systemd/system/webcameras.service
systemctl daemon-reload && systemctl restart webcameras
```

### Black screen / flashing red dot but no video

Camera is likely H.265/HEVC. Check:
```bash
ffprobe -rtsp_transport tcp -i 'rtsp://user:pass@ip/stream' \
  -v quiet -show_streams 2>&1 | grep codec_name
```
If it shows `hevc`, set resolution to `1080` (not `source`) in the camera config.

### `#EXT-X-ENDLIST` in playlist (stream stops after a few seconds)

```bash
# Check the playlist
cat /tmp/webcameras/hls/<camera-id>/stream.m3u8
```
If it contains `#EXT-X-ENDLIST`, restart the service:
```bash
rm -rf /tmp/webcameras/hls/*
systemctl restart webcameras
```

### Can't reach internet from LXC (git clone / update fails)

Check IP forwarding on Proxmox host:
```bash
cat /proc/sys/net/ipv4/ip_forward  # must be 1
echo 1 > /proc/sys/net/ipv4/ip_forward
echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
```

Check NAT rule exists:
```bash
iptables -t nat -L POSTROUTING -n -v | grep MASQUERADE
# If missing:
iptables -t nat -A POSTROUTING -s 192.168.145.0/24 -o eth0 -j MASQUERADE
```

### pct exec / pct push — sync_wait: 34

Use `lxc-attach` instead:
```bash
lxc-attach -n <vmid> -- passwd root
ssh root@<container-ip>
```

---

## LXC Container Specs

| Resource | Default |
|----------|---------|
| vCPUs | 2 (increase for more cameras) |
| RAM | 512 MB |
| Disk | 8 GB |
| Base OS | Ubuntu 22.04 LTS |
| App port | 8080 (internal) |
| Nginx port | 80 (external) |

Each H.265→H.264 ffmpeg transcode uses ~0.3–0.8 CPU cores at 1080p ultrafast preset.

---

## API Reference

```
GET    /api/config              — global config
PUT    /api/config              — update global config
GET    /api/version             — local version + GitHub latest check

GET    /api/layouts             — all layout pages
PUT    /api/layouts/:name       — create/update layout
DELETE /api/layouts/:name       — delete layout

GET    /api/streams             — active stream status
POST   /api/streams/:id/start   — start HLS transcode
POST   /api/streams/:id/stop    — stop HLS transcode
POST   /api/test-stream         — test camera connectivity
```

---

## Comparison with displaycameras

| Feature | displaycameras | webcameras |
|---------|---------------|------------|
| Display | HDMI / X11 | Any browser |
| Client devices | Raspberry Pi only | Phone, tablet, desktop |
| H.265/HEVC | No | Yes (transcodes to H.264) |
| Layout config | Shell variable arrays | JSON ratio-based windows |
| Live editing | No | Yes — drag and drop |
| Credentials | In URL | Separate username/password fields |
| Mobile | No | Yes — responsive + bottom nav |
| Multi-page | Yes (rotation) | Yes (tabs + rotation + default page) |
| Update mechanism | Manual | `update` command with version check |
| Container | No | LXC + Docker |
