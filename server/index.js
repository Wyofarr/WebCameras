#!/usr/bin/env node
/**
 * webcameras - Web-based IP camera display system
 * Version: 2026.07.10
 *
 * Always-on stream model:
 *  - ALL configured cameras stream continuously from server start
 *  - Streams never stop because a browser disconnected
 *  - Browser just attaches HLS.js to already-running segments
 *  - Per-camera 'enabled' flag to disable without deleting
 *  - Config changes trigger a sync: new cameras start, removed cameras stop
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
const HLS_DIR     = process.env.HLS_DIR  || '/var/lib/webcameras/hls';
const PID_DIR     = process.env.PID_DIR  || '/var/lib/webcameras/pids';

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(compression());
app.use(express.json());
app.use('/js',  express.static(path.join(__dirname, '../public/js'),  { maxAge: '7d', etag: true }));
app.use('/css', express.static(path.join(__dirname, '../public/css'), { maxAge: '7d', etag: true }));
app.use('/vendor', express.static(path.join(__dirname, '../public/vendor'), { maxAge: '30d', etag: true }));
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
      ...JSON.parse(fs.readFileSync(
        path.join(CONFIG_PATH,'webcameras.conf.json'),'utf8')) };
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
        try {
          layouts[name] = JSON.parse(
            fs.readFileSync(path.join(CONFIG_PATH, file),'utf8'));
        } catch(e) { console.error(`Failed to load ${file}:`, e.message); }
      });
  } catch(e) { console.error('Failed to read config dir:', e.message); }
  _layoutsCache = layouts;
  return _layoutsCache;
}

function invalidateCache() { _configCache = null; _layoutsCache = null; }

function saveLayout(name, data) {
  fs.writeFileSync(
    path.join(CONFIG_PATH,`layout.${name}.json`), JSON.stringify(data,null,2));
  invalidateCache();
}

function deleteLayout(name) {
  const file = path.join(CONFIG_PATH,`layout.${name}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  invalidateCache();
}

// ── Camera registry — all cameras across all layouts ─────────────────────────
const cameraRegistry = new Map(); // id → camera config

function getAllCameras() {
  const seen = new Set();
  const cameras = [];
  for (const layout of Object.values(loadLayouts())) {
    for (const cam of (layout.cameras || [])) {
      if (!seen.has(cam.id)) {
        seen.add(cam.id);
        cameras.push(cam);
      }
    }
  }
  return cameras;
}

function refreshCameraRegistry() {
  for (const cam of getAllCameras()) {
    cameraRegistry.set(cam.id, cam);
  }
}

// ── PID lockfile helpers ──────────────────────────────────────────────────────
function pidFile(id)      { return path.join(PID_DIR, `${id}.pid`); }
function readPidFile(id)  {
  try { return parseInt(fs.readFileSync(pidFile(id),'utf8').trim()); }
  catch { return null; }
}
function writePidFile(id, pid) {
  try { fs.writeFileSync(pidFile(id), String(pid)); } catch {}
}
function deletePidFile(id) {
  try { fs.unlinkSync(pidFile(id)); } catch {}
}

// ── Kill all ffmpeg processes for a camera ────────────────────────────────────
function killStreamProcesses(id) {
  const segPath = path.join(HLS_DIR, id, 'seg');
  const lockedPid = readPidFile(id);
  if (lockedPid) {
    try { process.kill(lockedPid, 'SIGKILL'); } catch {}
  }
  try {
    execSync(`pkill -9 -f "${segPath}" 2>/dev/null || true`, { timeout: 2000 });
  } catch {}
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
    const targetW = Math.round(h * aspect / 2) * 2;
    return ['-vf',
      `scale=${targetW}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${targetW}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`];
  }
  return ['-vf', `scale=-2:${h}`];
}

function buildFfmpegArgs(camera, url, dir) {
  const transport  = camera.transport  || 'tcp';
  const resolution = camera.resolution || '720';
  const bitrate    = parseInt(camera.bitrate) || 1500;
  const playlist   = path.join(dir, 'stream.m3u8');

  const videoArgs = resolution === 'source'
    ? ['-c:v', 'copy']
    : [
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
        ...buildVideoFilter(resolution, camera.windowW, camera.windowH,
          camera._pixelDims),
        '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`,
        '-bufsize', `${bitrate}k`,
        '-g', '60', '-sc_threshold', '0',
        '-pix_fmt', 'yuv420p',
        '-threads', '1',
      ];

  return [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-rtsp_transport', transport,
    '-rtbufsize', '256k',
    '-i', url,
    ...videoArgs,
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '4',
    '-hls_flags',
      'delete_segments+append_list+omit_endlist+split_by_time+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_allow_cache', '0',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    playlist
  ];
}

// ── Stream state ──────────────────────────────────────────────────────────────
const activeStreams  = new Map(); // id → { process, pid, startedAt, camera }
const crashCounts   = new Map(); // id → number
const restartTimers = new Map(); // id → timer
const BACKOFF_MS    = [3000, 6000, 12000, 30000, 60000];

function getBackoff(id) {
  return BACKOFF_MS[Math.min(crashCounts.get(id)||0, BACKOFF_MS.length-1)];
}

// ── Start stream (always-on — no client counter) ──────────────────────────────
async function startStream(camera) {
  const { id } = camera;
  const url = buildAuthUrl(camera.url, camera.username, camera.password);

  cameraRegistry.set(id, camera);

  // Already running — nothing to do
  if (activeStreams.has(id)) {
    console.log(`[stream] Already running: ${id}`);
    return;
  }

  // Skip disabled cameras
  if (camera.enabled === false) {
    console.log(`[stream] Skipping disabled camera: ${id}`);
    return;
  }

  if (restartTimers.has(id)) {
    clearTimeout(restartTimers.get(id));
    restartTimers.delete(id);
  }

  // Kill any stale processes before starting fresh
  killStreamProcesses(id);
  await new Promise(r => setTimeout(r, 300));
  cleanStreamDir(id);

  const dir = path.join(HLS_DIR, id);
  const args = buildFfmpegArgs(camera, url, dir);

  console.log(`[stream] Starting: ${id} (crashes: ${crashCounts.get(id)||0})`);

  const proc = spawn('ffmpeg', args, {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe']
  });

  writePidFile(id, proc.pid);
  console.log(`[stream] PID ${proc.pid} locked for ${id}`);

  proc.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`[ffmpeg:${id}] ${line}`);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[stream] Stopped: ${id} (code=${code} signal=${signal} pid=${proc.pid})`);

    const current = activeStreams.get(id);
    if (!current || current.pid !== proc.pid) {
      console.log(`[stream] Ignoring stale exit for ${id} (pid ${proc.pid})`);
      deletePidFile(id);
      return;
    }

    activeStreams.delete(id);
    deletePidFile(id);
    io.emit('stream:stopped', { id });

    // Don't restart intentionally killed streams
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      console.log(`[stream] ${id} stopped intentionally`);
      return;
    }

    // Always restart — this is an always-on system
    const count = (crashCounts.get(id) || 0) + 1;
    crashCounts.set(id, count);
    const delay = getBackoff(id);
    console.log(`[stream] Will restart ${id} in ${delay}ms (attempt ${count})`);

    const t = setTimeout(async () => {
      restartTimers.delete(id);
      const cam = cameraRegistry.get(id);
      if (cam && cam.enabled !== false) {
        await startStream(cam);
      }
    }, delay);
    restartTimers.set(id, t);
  });

  activeStreams.set(id, {
    process: proc, pid: proc.pid,
    startedAt: Date.now(), camera
  });

  // Reset crash count after 2 minutes stable
  const stableTimer = setTimeout(() => {
    if (activeStreams.has(id) && activeStreams.get(id).pid === proc.pid) {
      crashCounts.set(id, 0);
      console.log(`[stream] ${id} stable — crash count reset`);
    }
  }, 120000);
  stableTimer.unref();

  // Signal ready on first .ts segment
  let ready = false, watcher = null;
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

// ── Stop stream permanently (only called when camera deleted/disabled) ────────
function stopStream(id) {
  const s = activeStreams.get(id);
  if (s) {
    console.log(`[stream] Permanently stopping: ${id}`);
    killStreamProcesses(id);
    activeStreams.delete(id);
  }
  crashCounts.delete(id);
  if (restartTimers.has(id)) {
    clearTimeout(restartTimers.get(id));
    restartTimers.delete(id);
  }
}

// ── Sync running streams with current config ──────────────────────────────────
// Called on startup and whenever config changes.
// Starts new cameras, stops removed/disabled ones.
async function syncStreams() {
  const configured = getAllCameras();
  const configuredIds = new Set(configured.map(c => c.id));

  // Stop streams for cameras that no longer exist or are disabled
  for (const [id] of activeStreams) {
    const cam = cameraRegistry.get(id);
    if (!configuredIds.has(id) || cam?.enabled === false) {
      console.log(`[sync] Stopping removed/disabled camera: ${id}`);
      stopStream(id);
    }
  }

  // Also cancel restart timers for removed cameras
  for (const [id] of restartTimers) {
    if (!configuredIds.has(id)) {
      clearTimeout(restartTimers.get(id));
      restartTimers.delete(id);
    }
  }

  // Start new cameras that aren't running yet, staggered 2s apart
  const toStart = configured.filter(
    c => c.enabled !== false && !activeStreams.has(c.id)
  );

  if (toStart.length > 0) {
    console.log(`[sync] Starting ${toStart.length} camera(s)...`);
    for (const cam of toStart) {
      // Find window dims for this camera from any layout
      const dims = getCameraWindowDims(cam.id);
      await startStream({ ...cam, ...dims });
      if (toStart.length > 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
}

// Get window dimensions for a camera from its layout (for aspect ratio padding)
function getCameraWindowDims(cameraId) {
  for (const layout of Object.values(loadLayouts())) {
    const win = (layout.windows || []).find(
      w => w.cameraId === cameraId || w.id === cameraId
    );
    if (win) return { windowW: win.w, windowH: win.h };
  }
  return {};
}

// ── Startup cleanup ───────────────────────────────────────────────────────────
function killAllLegacyProcesses() {
  console.log('[startup] Killing legacy ffmpeg processes...');
  try {
    execSync(`pkill -9 -f "${HLS_DIR}" 2>/dev/null || true`, { timeout: 3000 });
  } catch {}
  try {
    fs.readdirSync(PID_DIR).filter(f => f.endsWith('.pid')).forEach(f => {
      try {
        const pid = parseInt(fs.readFileSync(path.join(PID_DIR,f),'utf8').trim());
        if (pid) process.kill(pid, 'SIGKILL');
      } catch {}
      try { fs.unlinkSync(path.join(PID_DIR, f)); } catch {}
    });
  } catch {}
  console.log('[startup] Done');
}

// ── CPU watchdog ──────────────────────────────────────────────────────────────
setInterval(() => {
  try {
    const count = parseInt(
      execSync(`pgrep -c -f "${HLS_DIR}" 2>/dev/null || echo 0`,
        { timeout:2000 }).toString().trim()) || 0;
    const expected = activeStreams.size;
    if (count > expected + 2) {
      console.warn(`[watchdog] ${count} ffmpeg but ${expected} tracked — resetting`);
      try {
        execSync(`pkill -9 -f "${HLS_DIR}" 2>/dev/null || true`, { timeout:2000 });
      } catch {}
      for (const [id] of activeStreams) {
        deletePidFile(id);
        activeStreams.delete(id);
      }
      // Re-sync after a brief pause
      setTimeout(syncStreams, 3000);
    }
  } catch {}
}, 15000);

// ── Disk guard ────────────────────────────────────────────────────────────────
setInterval(() => {
  try {
    const pct = parseInt(
      execSync(`df "${HLS_DIR}" | tail -1`, { timeout:2000 })
      .toString().trim().split(/\s+/)[4]);
    if (pct > 90) {
      console.error(`[disk] ${pct}% full — stopping streams`);
      io.emit('system:warning', { message:`Disk ${pct}% full` });
      for (const [id] of activeStreams) stopStream(id);
    }
  } catch {}
}, 60000);

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => res.json(loadConfig()));

app.put('/api/config', (req, res) => {
  const conf = { ...loadConfig(), ...req.body };
  fs.writeFileSync(
    path.join(CONFIG_PATH,'webcameras.conf.json'), JSON.stringify(conf,null,2));
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
  // Sync streams after config change — starts new cameras, stops removed ones
  setTimeout(syncStreams, 500);
  io.emit('layouts:updated');
  res.json({ ok:true });
});

app.delete('/api/layouts/:name', (req, res) => {
  deleteLayout(req.params.name);
  setTimeout(syncStreams, 500);
  io.emit('layouts:updated');
  res.json({ ok:true });
});

// Stream status — now includes ALL configured cameras, not just active ones
app.get('/api/streams', (req, res) => {
  const result = {};
  // All configured cameras
  for (const cam of getAllCameras()) {
    const s = activeStreams.get(cam.id);
    result[cam.id] = {
      label:     cam.label || cam.id,
      enabled:   cam.enabled !== false,
      live:      !!s,
      startedAt: s?.startedAt || null,
      pid:       s?.pid || null,
      hlsUrl:    `/hls/${cam.id}/stream.m3u8`,
      crashes:   crashCounts.get(cam.id) || 0,
    };
  }
  res.json(result);
});

// Browser requests HLS URL — server already has it running
// Just return the HLS URL, no need to start anything
app.post('/api/streams/:cameraId/start', (req, res) => {
  const id = req.params.cameraId;
  const s = activeStreams.get(id);
  if (s) {
    // Already running — just tell the browser where to find it
    res.json({ ok:true, hlsUrl:`/hls/${id}/stream.m3u8`, alreadyRunning:true });
  } else {
    // Not running — maybe disabled or new camera, start it
    const cam = cameraRegistry.get(id);
    if (cam) {
      startStream(cam).catch(console.error);
      res.json({ ok:true, hlsUrl:`/hls/${id}/stream.m3u8`, starting:true });
    } else {
      res.status(404).json({ error:'Camera not found in registry' });
    }
  }
});

// Stop endpoint — disables a camera (sets enabled=false in its layout)
app.post('/api/streams/:cameraId/stop', (req, res) => {
  stopStream(req.params.cameraId);
  res.json({ ok:true });
});

// Toggle camera enabled/disabled
app.post('/api/streams/:cameraId/toggle', async (req, res) => {
  const id = req.params.cameraId;
  const layouts = loadLayouts();
  let found = false;
  for (const [name, layout] of Object.entries(layouts)) {
    const cam = (layout.cameras||[]).find(c => c.id === id);
    if (cam) {
      cam.enabled = cam.enabled === false ? true : false;
      saveLayout(name, layout);
      found = true;
      if (cam.enabled) {
        await startStream(cam);
      } else {
        stopStream(id);
      }
      break;
    }
  }
  if (!found) return res.status(404).json({ error:'Camera not found' });
  res.json({ ok:true, enabled: found });
});

app.post('/api/test-stream', (req, res) => {
  const { transport='tcp' } = req.body;
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
    } else { res.json({ ok:false, error:'Could not connect' }); }
  });
  setTimeout(() => {
    if (done) return; done = true;
    proc.kill();
    res.json({ ok:false, error:'Timed out' });
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
      const ghGet = (host, p) => new Promise(resolve => {
        const r = https.get({
          hostname:host, path:p,
          headers:{'User-Agent':'webcameras'}, timeout:5000
        }, res2 => {
          let d=''; res2.on('data',x=>d+=x);
          res2.on('end',()=>{ try{resolve(JSON.parse(d));}catch{resolve(null);}});
        });
        r.on('error',()=>resolve(null));
        r.on('timeout',()=>{r.destroy();resolve(null);});
      });
      const rel = await ghGet('api.github.com',`/repos/${repo}/releases/latest`);
      latest = rel?.tag_name?.replace(/^v/,'') || null;
      if (!latest) {
        const p = await ghGet('raw.githubusercontent.com',`/${repo}/main/package.json`);
        latest = p?.version || null;
      }
    }
  } catch {}
  res.json({ version:local, latest, repo, upToDate:latest?local===latest:null });
});

app.get('/api/system', (req, res) => {
  const info = { hlsDir:HLS_DIR, pidDir:PID_DIR,
    streams:activeStreams.size, configured:getAllCameras().length };
  try {
    const du = execSync(`df -h "${HLS_DIR}" | tail -1`,{timeout:2000})
      .toString().trim().split(/\s+/);
    info.disk = { size:du[1], used:du[2], avail:du[3], pct:du[4] };
  } catch {}
  try {
    info.ffmpegCount = parseInt(
      execSync(`pgrep -c -f "${HLS_DIR}" 2>/dev/null || echo 0`,{timeout:2000})
      .toString().trim()) || 0;
  } catch {}
  res.json(info);
});

app.get('/health', (req, res) => {
  let ffmpegOk = false;
  try { execSync('which ffmpeg',{timeout:1000}); ffmpegOk=true; } catch {}
  res.json({
    status: 'ok', version: pkg.version,
    streams: activeStreams.size,
    configured: getAllCameras().length,
    ffmpeg: ffmpegOk,
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().rss/1024/1024)+'MB'
  });
});

app.get('/config', (req,res) =>
  res.sendFile(path.join(__dirname,'../public/config.html')));
app.get('*', (req,res) =>
  res.sendFile(path.join(__dirname,'../public/index.html')));

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[ws] Client: ${socket.id}`);
  // Send current stream status on connect so browser knows what's live
  const status = {};
  for (const [id, s] of activeStreams)
    status[id] = { live:true, hlsUrl:`/hls/${id}/stream.m3u8` };
  socket.emit('streams:status', status);
  socket.on('disconnect', () => console.log(`[ws] Disconnected: ${socket.id}`));
});

// ── Config file watcher ───────────────────────────────────────────────────────
let chokidarDebounce = null;
chokidar.watch(CONFIG_PATH, { ignoreInitial:true }).on('all', (_, p) => {
  console.log(`[config] Changed: ${path.basename(p)}`);
  invalidateCache();
  refreshCameraRegistry();
  if (chokidarDebounce) clearTimeout(chokidarDebounce);
  chokidarDebounce = setTimeout(() => {
    chokidarDebounce = null;
    io.emit('layouts:updated');
    syncStreams(); // start new cameras, stop removed ones
  }, 500);
});

// ── Startup ───────────────────────────────────────────────────────────────────
refreshCameraRegistry();
killAllLegacyProcesses();

// Start ALL configured cameras after 3s
setTimeout(() => {
  console.log('[startup] Starting all configured cameras...');
  syncStreams().catch(console.error);
}, 3000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n+==========================================+`);
  console.log(`|  WebCameras ${pkg.version} -- port ${PORT}     |`);
  console.log(`|  HLS:  ${HLS_DIR}  |`);
  console.log(`|  PIDs: ${PID_DIR}  |`);
  console.log(`+==========================================+\n`);
});

process.on('SIGTERM', () => {
  console.log('[shutdown] Stopping all streams...');
  for (const [id] of activeStreams) stopStream(id);
  server.close(() => process.exit(0));
});
