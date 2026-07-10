#!/usr/bin/env node
/**
 * webcameras - Web-based IP camera display system
 * Inspired by displaycameras (github.com/Anonymousdog/displaycameras)
 * Version: 2026.07.02
 */

const express     = require('express');
const http        = require('http');
const { Server }  = require('socket.io');
const path        = require('path');
const fs          = require('fs');
const { spawn }   = require('child_process');
const chokidar    = require('chokidar');
const compression = require('compression');
const pkg         = require('../package.json');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '../config');
const PORT        = process.env.PORT || 8080;
const HLS_DIR     = '/tmp/webcameras/hls';

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// ─── Gzip compression for all text responses ─────────────────────────────────
app.use(compression());
app.use(express.json());

// ─── Static files — long cache for JS/CSS (content doesn't change between
//     deploys without a version bump), no cache for HTML (always fresh) ───────
app.use('/js',  express.static(path.join(__dirname, '../public/js'),  { maxAge: '7d', etag: true }));
app.use('/css', express.static(path.join(__dirname, '../public/css'), { maxAge: '7d', etag: true }));
app.use(express.static(path.join(__dirname, '../public'), { maxAge: 0, etag: true }));

// HLS segments — never cache
app.use('/hls', express.static(HLS_DIR, {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Access-Control-Allow-Origin', '*');
  }
}));

fs.mkdirSync(HLS_DIR, { recursive: true });

// ─── In-memory config cache ───────────────────────────────────────────────────
// Reads from disk once, then served from memory. chokidar invalidates on change.
let _configCache  = null;
let _layoutsCache = null;

function loadConfig() {
  if (_configCache) return _configCache;
  const defaults = { title:'WebCameras', rotate:false, rotatedelay:30,
    startsleep:2, feedsleep:2, retry:3, defaultPage:'' };
  try {
    _configCache = { ...defaults,
      ...JSON.parse(fs.readFileSync(path.join(CONFIG_PATH,'webcameras.conf.json'),'utf8')) };
  } catch { _configCache = defaults; }
  return _configCache;
}

function loadLayouts() {
  if (_layoutsCache) return _layoutsCache;
  const layouts = {};
  try {
    const files = fs.readdirSync(CONFIG_PATH)
      .filter(f => f.startsWith('layout.') && f.endsWith('.json'));
    for (const file of files) {
      const name = file.replace(/^layout\./,'').replace(/\.json$/,'');
      try {
        layouts[name] = JSON.parse(fs.readFileSync(path.join(CONFIG_PATH, file),'utf8'));
      } catch(e) { console.error(`Failed to load layout ${file}:`, e.message); }
    }
  } catch(e) { console.error('Failed to read config dir:', e.message); }
  _layoutsCache = layouts;
  return _layoutsCache;
}

function invalidateCache() {
  _configCache  = null;
  _layoutsCache = null;
}

function saveLayout(name, data) {
  fs.writeFileSync(path.join(CONFIG_PATH,`layout.${name}.json`), JSON.stringify(data,null,2));
  invalidateCache();
}

function deleteLayout(name) {
  const file = path.join(CONFIG_PATH,`layout.${name}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  invalidateCache();
}

// ─── Camera registry ─────────────────────────────────────────────────────────
const cameraRegistry = new Map();

function refreshCameraRegistry() {
  const layouts = loadLayouts();
  for (const layout of Object.values(layouts)) {
    for (const cam of (layout.cameras || [])) {
      cameraRegistry.set(cam.id, cam);
    }
  }
}

// ─── RTSP → HLS ──────────────────────────────────────────────────────────────
const activeStreams = new Map();

function getStreamDir(id) { return path.join(HLS_DIR, id); }

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

function buildVideoFilter(resolution, windowW, windowH) {
  const h = parseInt(resolution) || 1080;
  if (windowW && windowH && windowW > 0 && windowH > 0) {
    const aspect  = windowW / windowH;
    const targetH = h;
    const targetW = Math.round(targetH * aspect / 2) * 2;
    return [
      '-vf',
      `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,` +
      `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
    ];
  }
  return ['-vf', `scale=-2:${h}`];
}

function buildFfmpegArgs(camera, url, dir) {
  const transport  = camera.transport  || 'tcp';
  const resolution = camera.resolution || '1080';
  const bitrate    = parseInt(camera.bitrate) || 2500;
  const windowW    = camera.windowW;
  const windowH    = camera.windowH;
  const playlist   = path.join(dir, 'stream.m3u8');

  const videoArgs = resolution === 'source'
    ? ['-c:v', 'copy']
    : [
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        ...buildVideoFilter(resolution, windowW, windowH),
        '-b:v', `${bitrate}k`,
        '-maxrate', `${bitrate}k`,
        '-bufsize', `${bitrate * 2}k`,
        '-g', '30',
        '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p',
      ];

  return [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-rtsp_transport', transport,
    '-rtbufsize', '512k',
    '-i', url,
    ...videoArgs,
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ac', '1',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+omit_endlist+split_by_time',
    '-hls_segment_type', 'mpegts',
    '-hls_allow_cache', '0',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    playlist
  ];
}

function startStream(camera) {
  const { id } = camera;
  const url = buildAuthUrl(camera.url, camera.username, camera.password);

  cameraRegistry.set(id, camera);

  if (activeStreams.has(id)) {
    activeStreams.get(id).clients++;
    console.log(`[stream] Reusing: ${id} (clients: ${activeStreams.get(id).clients})`);
    return;
  }

  const dir = getStreamDir(id);
  fs.mkdirSync(dir, { recursive: true });

  // Wipe stale segments
  try {
    fs.readdirSync(dir).forEach(f => {
      if (f.endsWith('.ts') || f.endsWith('.m3u8'))
        fs.unlinkSync(path.join(dir, f));
    });
  } catch {}

  const args = buildFfmpegArgs(camera, url, dir);
  console.log(`[stream] Starting: ${id}`);
  const proc = spawn('ffmpeg', args, { detached: false });

  proc.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`[ffmpeg:${id}] ${line}`);
  });

  proc.on('exit', (code) => {
    console.log(`[stream] Stopped: ${id} (code ${code})`);
    activeStreams.delete(id);
    io.emit('stream:stopped', { id });

    setTimeout(() => {
      if (io.sockets.sockets.size > 0) {
        const cam = cameraRegistry.get(id);
        if (cam) {
          console.log(`[stream] Auto-restarting: ${id}`);
          startStream(cam);
        }
      }
    }, 3000);
  });

  activeStreams.set(id, { process: proc, clients: 1, startedAt: Date.now(), camera });

  // Signal ready on first .ts segment
  let ready = false;
  const watcher = fs.watch(dir, (event, filename) => {
    if (!ready && filename && filename.endsWith('.ts')) {
      ready = true;
      try { watcher.close(); } catch {}
      setTimeout(() => io.emit('stream:ready', { id }), 300);
    }
  });
  setTimeout(() => {
    if (!ready) {
      ready = true;
      try { watcher.close(); } catch {}
      io.emit('stream:ready', { id });
    }
  }, 10000);
}

function stopStream(id) {
  const s = activeStreams.get(id);
  if (!s) return;
  s.clients = Math.max(0, s.clients - 1);
  if (s.clients <= 0) {
    console.log(`[stream] Killing: ${id}`);
    s.process.kill('SIGTERM');
    activeStreams.delete(id);
    const dir = getStreamDir(id);
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true }); } catch {} }, 2000);
  }
}

// ─── Pre-warm default page streams ───────────────────────────────────────────
// Start ffmpeg for cameras on the default page before any browser connects.
// First frame will already be ready when the user opens the page.
function prewarmDefaultPage() {
  const config  = loadConfig();
  const layouts = loadLayouts();
  const pageName = config.defaultPage || Object.keys(layouts)[0];
  if (!pageName || !layouts[pageName]) return;

  const layout = layouts[pageName];
  const windows = layout.windows || [];
  const cameras = layout.cameras || [];

  console.log(`[prewarm] Pre-warming streams for default page: ${pageName}`);

  for (const win of windows) {
    const cam = cameras.find(c => c.id === (win.cameraId || win.id));
    if (!cam) continue;
    // Start with window dimensions for correct padding
    startStream({ ...cam, windowW: win.w, windowH: win.h });
  }
}

// ─── API ─────────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => res.json(loadConfig()));

app.put('/api/config', (req, res) => {
  const conf = { ...loadConfig(), ...req.body };
  fs.writeFileSync(path.join(CONFIG_PATH,'webcameras.conf.json'), JSON.stringify(conf,null,2));
  invalidateCache();
  io.emit('config:updated', conf);
  res.json(conf);
});

app.get('/api/layouts', (req, res) => res.json(loadLayouts()));

app.get('/api/layouts/:name', (req, res) => {
  const layout = loadLayouts()[req.params.name];
  if (!layout) return res.status(404).json({ error:'Not found' });
  res.json(layout);
});

app.put('/api/layouts/:name', (req, res) => {
  saveLayout(req.params.name, req.body);
  refreshCameraRegistry();
  io.emit('layouts:updated');
  res.json({ ok:true });
});

app.delete('/api/layouts/:name', (req, res) => {
  deleteLayout(req.params.name);
  io.emit('layouts:updated');
  res.json({ ok:true });
});

app.post('/api/streams/:cameraId/start', (req, res) => {
  const { url, transport, username, password, resolution, bitrate, windowW, windowH } = req.body;
  if (!url) return res.status(400).json({ error:'url required' });
  startStream({ id:req.params.cameraId, url, transport, username, password,
    resolution, bitrate, windowW, windowH });
  res.json({ ok:true, hlsUrl:`/hls/${req.params.cameraId}/stream.m3u8` });
});

app.post('/api/streams/:cameraId/stop', (req, res) => {
  stopStream(req.params.cameraId);
  res.json({ ok:true });
});

app.get('/api/streams', (req, res) => {
  const result = {};
  for (const [id, s] of activeStreams) {
    result[id] = { clients:s.clients, startedAt:s.startedAt,
      hlsUrl:`/hls/${id}/stream.m3u8` };
  }
  res.json(result);
});

app.post('/api/test-stream', (req, res) => {
  const { transport = 'tcp' } = req.body;
  const url = buildAuthUrl(req.body.url, req.body.username, req.body.password);
  let done = false;
  const proc = spawn('ffprobe', [
    '-rtsp_transport', transport, '-i', url,
    '-v', 'quiet', '-print_format', 'json', '-show_streams'
  ]);
  let out = '';
  proc.stdout.on('data', d => out += d);
  proc.on('exit', code => {
    if (done) return; done = true;
    if (code === 0) {
      try { res.json({ ok:true, info:JSON.parse(out) }); }
      catch { res.json({ ok:true }); }
    } else { res.json({ ok:false, error:'Could not connect to stream' }); }
  });
  setTimeout(() => {
    if (done) return; done = true;
    proc.kill();
    res.json({ ok:false, error:'Connection timed out' });
  }, 8000);
});

app.get('/api/version', async (req, res) => {
  const local = pkg.version;
  let latest = null, repo = null;
  try {
    const repoUrl = pkg.repository?.url || '';
    const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (match) {
      repo = match[1].replace(/\.git$/, '');
      const https = require('https');
      latest = await new Promise((resolve) => {
        const req2 = https.get({
          hostname: 'api.github.com',
          path: `/repos/${repo}/releases/latest`,
          headers: { 'User-Agent': 'webcameras' },
          timeout: 5000
        }, (r) => {
          let data = '';
          r.on('data', d => data += d);
          r.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.tag_name ? json.tag_name.replace(/^v/, '') : null);
            } catch { resolve(null); }
          });
        });
        req2.on('error', () => resolve(null));
        req2.on('timeout', () => { req2.destroy(); resolve(null); });
      });

      // Fall back to package.json on main branch if no releases
      if (!latest) {
        latest = await new Promise((resolve) => {
          const req3 = https.get({
            hostname: 'raw.githubusercontent.com',
            path: `/${repo}/main/package.json`,
            headers: { 'User-Agent': 'webcameras' },
            timeout: 5000
          }, (r) => {
            let data = '';
            r.on('data', d => data += d);
            r.on('end', () => {
              try { resolve(JSON.parse(data).version || null); }
              catch { resolve(null); }
            });
          });
          req3.on('error', () => resolve(null));
          req3.on('timeout', () => { req3.destroy(); resolve(null); });
        });
      }
    }
  } catch { latest = null; }

  res.json({ version:local, latest, repo, upToDate: latest ? local === latest : null });
});

app.get('/config', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/config.html')));

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/index.html')));

// ─── Socket.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[ws] Client connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[ws] Client disconnected: ${socket.id}`));
});

// ─── Config file watcher — invalidates in-memory cache ───────────────────────
chokidar.watch(CONFIG_PATH, { ignoreInitial: true }).on('all', (event, filePath) => {
  console.log(`[config] File changed: ${path.basename(filePath)} — invalidating cache`);
  invalidateCache();
  refreshCameraRegistry();
  io.emit('layouts:updated');
});

// ─── Startup ─────────────────────────────────────────────────────────────────
refreshCameraRegistry();

// Pre-warm after a short delay to let the system settle
setTimeout(prewarmDefaultPage, 3000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  WebCameras ${pkg.version} — port ${PORT}      ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});

process.on('SIGTERM', () => {
  console.log('[shutdown] Stopping all streams...');
  for (const [id] of activeStreams) stopStream(id);
  process.exit(0);
});
