#!/usr/bin/env node
/**
 * webcameras - Web-based IP camera display system
 * Version: 2026.07.09
 *
 * Stream management rewrite:
 *  - Kill by segment path pattern (pkill -f) instead of lsof — fast and reliable
 *  - PID lockfile per camera — survives server restarts, prevents ghost processes
 *  - Hard client cap: max 1 ffmpeg process per camera regardless of browser tabs
 *  - Staggered startup: cameras start 2s apart to avoid CPU spike
 *  - Reduced default bitrate to 1500k (sufficient for 720p, much lighter on CPU)
 */

const express     = require('express');
const http        = require('http');
const { Server }  = require('socket.io');
const path        = require('path');
const fs          = require('fs');
const { spawn, execSync } = require('child_process');
const chokidar    = require('chokidar');
const compression = require('compression');
const pkg         = require('../package.json');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '../config');
const PORT        = process.env.PORT || 8080;
const HLS_DIR     = process.env.HLS_DIR || '/var/lib/webcameras/hls';
const PID_DIR     = process.env.PID_DIR  || '/var/lib/webcameras/pids';

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(compression());
app.use(express.json());
app.use('/js',  express.static(path.join(__dirname, '../public/js'),  { maxAge: '7d', etag: true }));
app.use('/css', express.static(path.join(__dirname, '../public/css'), { maxAge: '7d', etag: true }));
app.use(express.static(path.join(__dirname, '../public'), { maxAge: 0, etag: true }));
app.use('/hls', express.static(HLS_DIR, {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Access-Control-Allow-Origin', '*');
  }
}));

fs.mkdirSync(HLS_DIR, { recursive: true });
fs.mkdirSync(PID_DIR, { recursive: true });

// ── Config cache ──────────────────────────────────────────────────────────────
let _configCache = null, _layoutsCache = null;

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
    fs.readdirSync(CONFIG_PATH)
      .filter(f => f.startsWith('layout.') && f.endsWith('.json'))
      .forEach(file => {
        const name = file.replace(/^layout\./,'').replace(/\.json$/,'');
        try { layouts[name] = JSON.parse(
          fs.readFileSync(path.join(CONFIG_PATH, file),'utf8')); }
        catch(e) { console.error(`Failed to load ${file}:`, e.message); }
      });
  } catch(e) { console.error('Failed to read config dir:', e.message); }
  _layoutsCache = layouts;
  return _layoutsCache;
}

function invalidateCache() { _configCache = null; _layoutsCache = null; }
function saveLayout(name, data) {
  fs.writeFileSync(path.join(CONFIG_PATH,`layout.${name}.json`),
    JSON.stringify(data,null,2));
  invalidateCache();
}
function deleteLayout(name) {
  const file = path.join(CONFIG_PATH,`layout.${name}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  invalidateCache();
}

// ── Camera registry ───────────────────────────────────────────────────────────
const cameraRegistry = new Map();
function refreshCameraRegistry() {
  for (const layout of Object.values(loadLayouts()))
    for (const cam of (layout.cameras || []))
      cameraRegistry.set(cam.id, cam);
}

// ── PID lockfile helpers ──────────────────────────────────────────────────────
// One lockfile per camera ID. Written on start, deleted on clean stop.
// On restart, any process matching the lockfile PID is killed first.
function pidFile(id) { return path.join(PID_DIR, `${id}.pid`); }

function readPidFile(id) {
  try { return parseInt(fs.readFileSync(pidFile(id), 'utf8').trim()); }
  catch { return null; }
}

function writePidFile(id, pid) {
  try { fs.writeFileSync(pidFile(id), String(pid)); } catch {}
}

function deletePidFile(id) {
  try { fs.unlinkSync(pidFile(id)); } catch {}
}

// ── Kill all ffmpeg processes for a camera ────────────────────────────────────
// Uses three methods in order — fast, reliable, no lsof dependency:
//   1. Kill by PID from lockfile (handles clean restart after server crash)
//   2. pkill by HLS segment path pattern (kills any process writing to this dir)
//   3. Kill via our own process handle if we have one
function killStreamProcesses(id) {
  const segPath = path.join(HLS_DIR, id, 'seg');

  // Method 1: lockfile PID
  const lockedPid = readPidFile(id);
  if (lockedPid) {
    try { process.kill(lockedPid, 'SIGKILL'); }
    catch {}
  }

  // Method 2: pkill by segment path — catches ALL ffmpeg writing to this camera
  // This is the nuclear option that gets ghost processes
  try {
    execSync(`pkill -9 -f "${segPath}" 2>/dev/null || true`, { timeout: 2000 });
  } catch {}

  // Method 3: our tracked process handle
  const s = activeStreams.get(id);
  if (s && s.process && !s.process.killed) {
    try { s.process.kill('SIGKILL'); } catch {}
  }

  deletePidFile(id);
}

// ── Clean HLS directory ───────────────────────────────────────────────────────
function cleanStreamDir(id) {
  const dir = path.join(HLS_DIR, id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try {
    fs.readdirSync(dir).forEach(f => {
      if (f.endsWith('.ts') || f.endsWith('.m3u8') || f.endsWith('.tmp'))
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
    });
  } catch {}
}

// ── Auth URL builder ──────────────────────────────────────────────────────────
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

// ── Video filter ──────────────────────────────────────────────────────────────
function buildVideoFilter(resolution, windowW, windowH, pixelDims) {
  const h = parseInt(resolution) || 720;
  if (windowW && windowH && windowW > 0 && windowH > 0) {
    const aspect = pixelDims
      ? windowW / windowH
      : (windowW * 1920) / (windowH * 1080);
    const targetH = h;
    const targetW = Math.round(targetH * aspect / 2) * 2;
    return ['-vf',
      `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,` +
      `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`];
  }
  return ['-vf', `scale=-2:${h}`];
}

function buildFfmpegArgs(camera, url, dir) {
  const transport  = camera.transport   || 'tcp';
  const resolution = camera.resolution  || '720';
  const bitrate    = parseInt(camera.bitrate) || 1500;
  const playlist   = path.join(dir, 'stream.m3u8');

  const videoArgs = resolution === 'source'
    ? ['-c:v', 'copy']
    : [
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
        ...buildVideoFilter(resolution, camera.windowW, camera.windowH,
          camera._pixelDims),
        '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`,
        '-bufsize', `${bitrate}k`,   // tighter buffer = less CPU buffering
        '-g', '60',                  // keyframe every 60 frames @ 30fps = 2s
        '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p',
        '-threads', '1',             // 1 thread per ffmpeg = predictable CPU
      ];

  return [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-rtsp_transport', transport,
    '-rtbufsize', '256k',            // smaller input buffer
    '-i', url,
    ...videoArgs,
    '-c:a', 'aac', '-b:a', '64k',   // lower audio bitrate
    '-ac', '1',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '4',           // fewer segments in playlist
    '-hls_flags', 'delete_segments+append_list+omit_endlist+split_by_time+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_allow_cache', '0',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    playlist
  ];
}

// ── Stream state ──────────────────────────────────────────────────────────────
const activeStreams = new Map();
const crashCounts  = new Map();
const restartTimers = new Map();
const BACKOFF_MS   = [3000, 6000, 12000, 30000, 60000];

function getBackoff(id) {
  const n = crashCounts.get(id) || 0;
  return BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)];
}

// ── Start stream ──────────────────────────────────────────────────────────────
async function startStream(camera) {
  const { id } = camera;
  const url = buildAuthUrl(camera.url, camera.username, camera.password);

  cameraRegistry.set(id, camera);

  // Hard guard: if a process is already tracked and alive, just increment clients
  if (activeStreams.has(id)) {
    activeStreams.get(id).clients++;
    console.log(`[stream] Reusing: ${id} (clients: ${activeStreams.get(id).clients})`);
    return;
  }

  // Cancel any pending restart timer
  if (restartTimers.has(id)) {
    clearTimeout(restartTimers.get(id));
    restartTimers.delete(id);
  }

  // Kill ALL existing processes for this camera before starting fresh
  console.log(`[stream] Killing any existing processes for: ${id}`);
  killStreamProcesses(id);

  // Brief pause to ensure killed processes have released file handles
  await new Promise(r => setTimeout(r, 500));

  // Clean HLS dir so new process starts from seg00000
  cleanStreamDir(id);

  const dir = path.join(HLS_DIR, id);
  const args = buildFfmpegArgs(camera, url, dir);

  console.log(`[stream] Starting: ${id} (crashes: ${crashCounts.get(id)||0})`);

  const proc = spawn('ffmpeg', args, {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe']
  });

  // Write PID to lockfile immediately
  writePidFile(id, proc.pid);
  console.log(`[stream] PID ${proc.pid} -> ${pidFile(id)}`);

  proc.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`[ffmpeg:${id}] ${line}`);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[stream] Stopped: ${id} (code ${code}, signal ${signal}, pid ${proc.pid})`);

    // Only act on exit if this is still the tracked process
    // (prevents old ghost processes triggering restarts)
    const current = activeStreams.get(id);
    if (!current || current.pid !== proc.pid) {
      console.log(`[stream] Ignoring exit of stale process ${proc.pid} for ${id}`);
      deletePidFile(id);
      return;
    }

    activeStreams.delete(id);
    deletePidFile(id);
    io.emit('stream:stopped', { id });

    // Don't restart if killed intentionally (SIGTERM/SIGKILL)
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      console.log(`[stream] ${id} killed intentionally — no restart`);
      return;
    }

    const count = (crashCounts.get(id) || 0) + 1;
    crashCounts.set(id, count);
    const delay = getBackoff(id);
    console.log(`[stream] Restarting ${id} in ${delay}ms (attempt ${count})`);

    const t = setTimeout(async () => {
      restartTimers.delete(id);
      if (io.sockets.sockets.size === 0 && !activeStreams.has(id)) {
        console.log(`[stream] No clients — skipping restart of ${id}`);
        return;
      }
      const cam = cameraRegistry.get(id);
      if (cam) await startStream(cam);
    }, delay);

    restartTimers.set(id, t);
  });

  activeStreams.set(id, {
    process: proc,
    pid: proc.pid,
    clients: 1,
    startedAt: Date.now(),
    camera
  });

  // Reset crash count after 2 minutes of stable uptime
  const stableTimer = setTimeout(() => {
    if (activeStreams.has(id) && activeStreams.get(id).pid === proc.pid) {
      crashCounts.set(id, 0);
      console.log(`[stream] ${id} stable — crash count reset`);
    }
  }, 120000);
  stableTimer.unref();

  // Watch for first segment — ensure dir exists first
  let ready = false;
  let watcher = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, (event, filename) => {
      if (!ready && filename && filename.endsWith('.ts')) {
        ready = true;
        try { watcher.close(); } catch {}
        setTimeout(() => io.emit('stream:ready', { id }), 300);
      }
    });
  } catch (e) {
    console.warn(`[stream] Cannot watch dir for ${id}: ${e.message}`);
  }
  setTimeout(() => {
    if (!ready) {
      ready = true;
      try { if (watcher) watcher.close(); } catch {}
      io.emit('stream:ready', { id });
    }
  }, 15000);
}

function stopStream(id) {
  const s = activeStreams.get(id);
  if (!s) return;
  s.clients = Math.max(0, s.clients - 1);
  if (s.clients <= 0) {
    console.log(`[stream] Stopping: ${id} (pid ${s.pid})`);
    killStreamProcesses(id);
    activeStreams.delete(id);
    crashCounts.delete(id);
    if (restartTimers.has(id)) {
      clearTimeout(restartTimers.get(id));
      restartTimers.delete(id);
    }
  }
}

// ── Startup cleanup ───────────────────────────────────────────────────────────
// On server start, kill any ffmpeg processes left from a previous run
function killAllLegacyProcesses() {
  console.log('[startup] Killing any legacy ffmpeg processes...');
  try {
    execSync(`pkill -9 -f "${HLS_DIR}" 2>/dev/null || true`, { timeout: 3000 });
  } catch {}

  // Also kill anything referenced in PID files
  try {
    const pids = fs.readdirSync(PID_DIR).filter(f => f.endsWith('.pid'));
    for (const pidFile2 of pids) {
      try {
        const pid = parseInt(fs.readFileSync(
          path.join(PID_DIR, pidFile2), 'utf8').trim());
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {}
      try { fs.unlinkSync(path.join(PID_DIR, pidFile2)); } catch {}
    }
  } catch {}

  console.log('[startup] Legacy process cleanup complete');
}

// ── CPU watchdog ──────────────────────────────────────────────────────────────
// Simpler than before: just count total ffmpeg processes.
// If more than (cameras + 1) are running, kill all and let them restart clean.
setInterval(() => {
  try {
    const result = execSync(
      `pgrep -c -f "${HLS_DIR}" 2>/dev/null || echo 0`,
      { timeout: 2000 }
    ).toString().trim();
    const count = parseInt(result) || 0;
    const expected = activeStreams.size;
    if (count > expected + 2) {
      console.warn(
        `[watchdog] ${count} ffmpeg processes but only ${expected} tracked — ` +
        `killing all and restarting`
      );
      try {
        execSync(`pkill -9 -f "${HLS_DIR}" 2>/dev/null || true`,
          { timeout: 2000 });
      } catch {}
      // Clear all active streams — they'll restart via their exit handlers
      for (const [id, s] of activeStreams) {
        deletePidFile(id);
        activeStreams.delete(id);
      }
    }
  } catch {}
}, 15000);

// ── Disk guard ────────────────────────────────────────────────────────────────
setInterval(() => {
  try {
    const out = execSync(`df "${HLS_DIR}" | tail -1`, { timeout:2000 })
      .toString().trim().split(/\s+/);
    const pct = parseInt(out[4]);
    if (pct > 90) {
      console.error(`[disk] HLS partition ${pct}% full — stopping streams`);
      io.emit('system:warning', { message:`Disk ${pct}% full — streams paused` });
      for (const [id] of activeStreams) stopStream(id);
    }
  } catch {}
}, 60000);

// ── Staggered prewarm ─────────────────────────────────────────────────────────
// Start cameras one at a time, 2 seconds apart, to avoid CPU spike on boot
async function prewarmDefaultPage() {
  const config  = loadConfig();
  const layouts = loadLayouts();
  const pageName = config.defaultPage || Object.keys(layouts)[0];
  if (!pageName || !layouts[pageName]) return;

  const layout  = layouts[pageName];
  const windows = layout.windows || [];
  const cameras = layout.cameras || [];

  console.log(`[prewarm] Staggered start for page: ${pageName}`);

  for (const win of windows) {
    const cam = cameras.find(c => c.id === (win.cameraId || win.id));
    if (!cam) continue;
    await startStream({ ...cam, windowW: win.w, windowH: win.h });
    // Wait 2s between each camera to stagger CPU load
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => res.json(loadConfig()));

app.put('/api/config', (req, res) => {
  const conf = { ...loadConfig(), ...req.body };
  fs.writeFileSync(path.join(CONFIG_PATH,'webcameras.conf.json'),
    JSON.stringify(conf,null,2));
  invalidateCache();
  io.emit('config:updated', conf);
  res.json(conf);
});

app.get('/api/layouts', (req, res) => res.json(loadLayouts()));

app.get('/api/layouts/:name', (req, res) => {
  const l = loadLayouts()[req.params.name];
  if (!l) return res.status(404).json({ error:'Not found' });
  res.json(l);
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

app.post('/api/streams/:cameraId/start', async (req, res) => {
  const { url, transport, username, password,
    resolution, bitrate, windowW, windowH, _pixelDims } = req.body;
  if (!url) return res.status(400).json({ error:'url required' });
  // Rate limit: max 20 start requests per camera per minute
  const key = req.params.cameraId;
  const count = (streamStartCounts.get(key) || 0) + 1;
  streamStartCounts.set(key, count);
  if (count > 20) {
    console.warn(`[ratelimit] Too many start requests for ${key}`);
    return res.status(429).json({ error:'Too many requests' });
  }
  await startStream({ id:req.params.cameraId, url, transport,
    username, password, resolution, bitrate, windowW, windowH, _pixelDims });
  res.json({ ok:true, hlsUrl:`/hls/${req.params.cameraId}/stream.m3u8` });
});

app.post('/api/streams/:cameraId/stop', (req, res) => {
  stopStream(req.params.cameraId);
  res.json({ ok:true });
});

app.get('/api/streams', (req, res) => {
  const result = {};
  for (const [id, s] of activeStreams)
    result[id] = { clients:s.clients, startedAt:s.startedAt, pid:s.pid,
      hlsUrl:`/hls/${id}/stream.m3u8`, crashes: crashCounts.get(id)||0 };
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
      repo = match[1].replace(/\.git$/,'');
      const https = require('https');
      const ghFetch = (host, p) => new Promise(resolve => {
        const r = https.get({
          hostname: host, path: p,
          headers: { 'User-Agent':'webcameras' }, timeout: 5000
        }, res2 => {
          let d = ''; res2.on('data', x => d += x);
          res2.on('end', () => {
            try { resolve(JSON.parse(d)); } catch { resolve(null); }
          });
        });
        r.on('error', () => resolve(null));
        r.on('timeout', () => { r.destroy(); resolve(null); });
      });
      const rel = await ghFetch('api.github.com',
        `/repos/${repo}/releases/latest`);
      latest = rel?.tag_name?.replace(/^v/,'') || null;
      if (!latest) {
        const p = await ghFetch('raw.githubusercontent.com',
          `/${repo}/main/package.json`);
        latest = p?.version || null;
      }
    }
  } catch {}
  res.json({ version:local, latest, repo,
    upToDate: latest ? local === latest : null });
});

app.get('/api/system', (req, res) => {
  const info = { hlsDir:HLS_DIR, pidDir:PID_DIR, streams:activeStreams.size };
  try {
    const du = execSync(`df -h "${HLS_DIR}" | tail -1`, { timeout:2000 })
      .toString().trim().split(/\s+/);
    info.disk = { size:du[1], used:du[2], avail:du[3], pct:du[4] };
  } catch {}
  try {
    const count = execSync(
      `pgrep -c -f "${HLS_DIR}" 2>/dev/null || echo 0`, { timeout:2000 })
      .toString().trim();
    info.ffmpegCount = parseInt(count) || 0;
  } catch {}
  res.json(info);
});

app.get('/health', (req, res) => {
  // Quick health check — useful for Proxmox monitoring and load balancers
  const healthy = activeStreams.size >= 0; // server is up
  let ffmpegAvailable = false;
  try { execSync('which ffmpeg', { timeout:1000 }); ffmpegAvailable = true; }
  catch {}
  res.status(healthy ? 200 : 503).json({
    status:   healthy ? 'ok' : 'degraded',
    version:  pkg.version,
    streams:  activeStreams.size,
    ffmpeg:   ffmpegAvailable,
    uptime:   Math.floor(process.uptime()),
    memory:   Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB'
  });
});

// Rate limit stream start — max 20 starts per minute per camera
const streamStartCounts = new Map();
setInterval(() => streamStartCounts.clear(), 60000);

app.get('/config', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/config.html')));
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[ws] Client: ${socket.id}`);
  socket.on('disconnect', () =>
    console.log(`[ws] Disconnected: ${socket.id}`));
});

let chokidarDebounce = null;
chokidar.watch(CONFIG_PATH, { ignoreInitial:true }).on('all', (_, p) => {
  console.log(`[config] Changed: ${path.basename(p)}`);
  invalidateCache(); refreshCameraRegistry();
  // Debounce 300ms — a single save triggers multiple fs events
  if (chokidarDebounce) clearTimeout(chokidarDebounce);
  chokidarDebounce = setTimeout(() => {
    io.emit('layouts:updated');
    chokidarDebounce = null;
  }, 300);
});

// ── Startup ───────────────────────────────────────────────────────────────────
refreshCameraRegistry();

// Kill any leftover ffmpeg from a previous run before starting fresh
killAllLegacyProcesses();

// Staggered prewarm after 3s
setTimeout(prewarmDefaultPage, 3000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n+==========================================+`);
  console.log(`|  WebCameras ${pkg.version} -- port ${PORT}      |`);
  console.log(`|  HLS: ${HLS_DIR}  |`);
  console.log(`|  PIDs: ${PID_DIR}             |`);
  console.log(`+==========================================+\n`);
});

process.on('SIGTERM', () => {
  console.log('[shutdown] Stopping all streams...');
  for (const [id] of activeStreams) stopStream(id);
  server.close(() => process.exit(0));
});
