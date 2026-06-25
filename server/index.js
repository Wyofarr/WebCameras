#!/usr/bin/env node
/**
 * webcameras - Web-based IP camera display system
 * Inspired by displaycameras (github.com/Anonymousdog/displaycameras)
 * Streams RTSP feeds to browser via HLS/MJPEG proxying
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const chokidar = require('chokidar');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '../config');
const PORT = process.env.PORT || 8080;
const HLS_DIR = '/tmp/webcameras/hls';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/hls', express.static(HLS_DIR, {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache');
    res.set('Access-Control-Allow-Origin', '*');
  }
}));

// Ensure HLS dir exists
fs.mkdirSync(HLS_DIR, { recursive: true });

// ─── Config Management ───────────────────────────────────────────────────────

function loadConfig() {
  const mainConf = path.join(CONFIG_PATH, 'webcameras.conf.json');
  const defaults = {
    title: 'WebCameras',
    rotate: false,
    rotatedelay: 30,
    startsleep: 2,
    feedsleep: 2,
    retry: 3,
    displaydetect: false
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(mainConf, 'utf8')) };
  } catch {
    return defaults;
  }
}

function loadLayouts() {
  const layouts = {};
  const files = fs.readdirSync(CONFIG_PATH).filter(f =>
    f.startsWith('layout.') && f.endsWith('.json')
  );
  for (const file of files) {
    const name = file.replace(/^layout\./, '').replace(/\.json$/, '');
    try {
      layouts[name] = JSON.parse(fs.readFileSync(path.join(CONFIG_PATH, file), 'utf8'));
    } catch (e) {
      console.error(`Failed to load layout ${file}:`, e.message);
    }
  }
  return layouts;
}

function saveLayout(name, data) {
  const file = path.join(CONFIG_PATH, `layout.${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function deleteLayout(name) {
  const file = path.join(CONFIG_PATH, `layout.${name}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ─── RTSP → HLS Transcoding ──────────────────────────────────────────────────

const activeStreams = new Map(); // cameraId → { process, clients, segment }

function getStreamDir(cameraId) {
  return path.join(HLS_DIR, cameraId);
}

function buildAuthUrl(url, username, password) {
  if (!url || !username) return url;
  try {
    const u = new URL(url);
    u.username = encodeURIComponent(username);
    u.password = encodeURIComponent(password || '');
    return u.toString();
  } catch {
    const proto = url.match(/^([a-z]+:\/\/)/i);
    if (proto) {
      const rest = url.slice(proto[1].length);
      const pass = password ? `:${encodeURIComponent(password)}` : '';
      return `${proto[1]}${encodeURIComponent(username)}${pass}@${rest}`;
    }
    return url;
  }
}

function buildFfmpegArgs(camera, url, dir) {
  const transport  = camera.transport || 'tcp';
  const resolution = camera.resolution || '1080';
  const bitrate    = camera.bitrate    || '2500';
  const playlist   = path.join(dir, 'stream.m3u8');

  // Source resolution = copy video (camera must be H.264)
  const videoArgs = resolution === 'source'
    ? ['-c:v', 'copy']
    : [
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-vf', `scale=-2:${resolution}`,
        '-b:v', `${bitrate}k`,
        '-maxrate', `${bitrate}k`,
        '-bufsize', `${parseInt(bitrate) * 2}k`,
        '-g', '30',
        '-sc_threshold', '0',
      ];

  return [
    '-hide_banner', '-loglevel', 'warning',
    '-rtsp_transport', transport,
    '-i', url,
    ...videoArgs,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(dir, 'seg%03d.ts'),
    playlist
  ];
}

function startStream(camera) {
  const { id, transport = 'tcp' } = camera;
  const url = buildAuthUrl(camera.url, camera.username, camera.password);
  if (activeStreams.has(id)) {
    activeStreams.get(id).clients++;
    return;
  }

  const dir = getStreamDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const args = buildFfmpegArgs(camera, url, dir);

  console.log(`[stream] Starting: ${id} → ${url}`);
  const proc = spawn('ffmpeg', args, { detached: false });

  proc.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`[ffmpeg:${id}] ${line}`);
  });

  proc.on('exit', (code) => {
    console.log(`[stream] Stopped: ${id} (code ${code})`);
    activeStreams.delete(id);
    io.emit('stream:stopped', { id });
    // Auto-restart if clients still watching
    setTimeout(() => {
      if (io.sockets.sockets.size > 0) {
        const layouts = loadLayouts();
        for (const layout of Object.values(layouts)) {
          const cam = (layout.cameras || []).find(c => c.id === id);
          if (cam) { startStream(cam); break; }
        }
      }
    }, 3000);
  });

  activeStreams.set(id, { process: proc, clients: 1, startedAt: Date.now() });

  // Notify when playlist appears
  const watcher = fs.watch(dir, (event, filename) => {
    if (filename === 'stream.m3u8') {
      io.emit('stream:ready', { id });
      watcher.close();
    }
  });
}

function stopStream(id) {
  const s = activeStreams.get(id);
  if (!s) return;
  s.clients--;
  if (s.clients <= 0) {
    console.log(`[stream] Killing: ${id}`);
    s.process.kill('SIGTERM');
    activeStreams.delete(id);
    // Cleanup HLS segments
    const dir = getStreamDir(id);
    try { fs.rmSync(dir, { recursive: true }); } catch {}
  }
}

// ─── API Routes ──────────────────────────────────────────────────────────────

// Get main config
app.get('/api/config', (req, res) => {
  res.json(loadConfig());
});

// Update main config
app.put('/api/config', (req, res) => {
  const conf = { ...loadConfig(), ...req.body };
  fs.writeFileSync(path.join(CONFIG_PATH, 'webcameras.conf.json'), JSON.stringify(conf, null, 2));
  io.emit('config:updated', conf);
  res.json(conf);
});

// List all layouts
app.get('/api/layouts', (req, res) => {
  res.json(loadLayouts());
});

// Get single layout
app.get('/api/layouts/:name', (req, res) => {
  const layouts = loadLayouts();
  const layout = layouts[req.params.name];
  if (!layout) return res.status(404).json({ error: 'Not found' });
  res.json(layout);
});

// Create/update layout
app.put('/api/layouts/:name', (req, res) => {
  saveLayout(req.params.name, req.body);
  io.emit('layouts:updated');
  res.json({ ok: true });
});

// Delete layout
app.delete('/api/layouts/:name', (req, res) => {
  deleteLayout(req.params.name);
  io.emit('layouts:updated');
  res.json({ ok: true });
});

// Start streaming a camera
app.post('/api/streams/:cameraId/start', (req, res) => {
  const { url, transport, username, password, resolution, bitrate } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  startStream({ id: req.params.cameraId, url, transport, username, password, resolution, bitrate });
  res.json({ ok: true, hlsUrl: `/hls/${req.params.cameraId}/stream.m3u8` });
});

// Stop streaming
app.post('/api/streams/:cameraId/stop', (req, res) => {
  stopStream(req.params.cameraId);
  res.json({ ok: true });
});

// Stream status
app.get('/api/streams', (req, res) => {
  const result = {};
  for (const [id, s] of activeStreams) {
    result[id] = { clients: s.clients, startedAt: s.startedAt, hlsUrl: `/hls/${id}/stream.m3u8` };
  }
  res.json(result);
});

// Test camera connectivity
app.post('/api/test-stream', async (req, res) => {
  const { transport = 'tcp' } = req.body;
  const url = buildAuthUrl(req.body.url, req.body.username, req.body.password);
  const proc = spawn('ffprobe', [
    '-rtsp_transport', transport,
    '-i', url,
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams'
  ]);
  let out = '';
  proc.stdout.on('data', d => out += d);
  proc.on('exit', code => {
    if (code === 0) {
      try { res.json({ ok: true, info: JSON.parse(out) }); }
      catch { res.json({ ok: true }); }
    } else {
      res.json({ ok: false, error: 'Could not connect to stream' });
    }
  });
  setTimeout(() => { proc.kill(); res.json({ ok: false, error: 'Timeout' }); }, 8000);
});

// Config UI
app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/config.html'));
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Socket.IO ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[ws] Client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`[ws] Client disconnected: ${socket.id}`);
  });
});

// ─── Config file watcher ─────────────────────────────────────────────────────

chokidar.watch(CONFIG_PATH, { ignoreInitial: true }).on('all', () => {
  io.emit('layouts:updated');
});

// ─── Startup ─────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  WebCameras running on port ${PORT}     ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

process.on('SIGTERM', () => {
  for (const [id] of activeStreams) stopStream(id);
  process.exit(0);
});
