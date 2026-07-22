#!/usr/bin/env node
/**
 * webcameras - Web-based IP camera display system
 * Version: 2026.07.06
 *
 * Key fixes in this version:
 *  - HLS segments moved to /var/lib/webcameras/hls (off tmpfs)
 *  - Duplicate process guard: kill+wait before restarting any stream
 *  - Exponential backoff on crash loops (3s → 6s → 12s → 30s)
 *  - CPU runaway prevention: SIGKILL if ffmpeg exceeds CPU threshold
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

// ── HLS on main disk — never on tmpfs which can fill and crash ffmpeg ────────
const HLS_DIR = process.env.HLS_DIR || '/var/lib/webcameras/hls';

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

// ── In-memory config cache ────────────────────────────────────────────────────
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
        try { layouts[name] = JSON.parse(fs.readFileSync(path.join(CONFIG_PATH, file),'utf8')); }
        catch(e) { console.error(`Failed to load ${file}:`, e.message); }
      });
  } catch(e) { console.error('Failed to read config dir:', e.message); }
  _layoutsCache = layouts;
  return _layoutsCache;
}

function invalidateCache() { _configCache = null; _layoutsCache = null; }

function saveLayout(name, data) {
  fs.writeFileSync(path.join(CONFIG_PATH,`layout.${name}.json`), JSON.stringify(data,null,2));
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

// ── Stream state ──────────────────────────────────────────────────────────────
// crashCounts tracks consecutive crashes per camera for exponential backoff
const activeStreams = new Map(); // id → { process, clients, startedAt, camera, pid }
const crashCounts  = new Map(); // id → number

const BACKOFF_MS = [3000, 6000, 12000, 30000]; // max 30s between retries

function getBackoff(id) {
  const count = crashCounts.get(id) || 0;
  return BACKOFF_MS[Math.min(count, BACKOFF_MS.length - 1)];
}

function getStreamDir(id) { return path.join(HLS_DIR, id); }

// ── Kill any existing ffmpeg writing to this stream dir ──────────────────────
// Prevents the duplicate-process race condition that corrupts segments.
async function killExistingForStream(id) {
  const dir = getStreamDir(id);
  try {
    // Find pids writing to this directory via /proc
    const result = execSync(
      `lsof +D "${dir}" 2>/dev/null | awk 'NR>1 {print $2}' | sort -u`,
      { timeout: 3000 }
    ).toString().trim();

    if (result) {
      const pids = result.split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          console.log(`[stream] Killing stale ffmpeg pid ${pid} for ${id}`);
          process.kill(parseInt(pid), 'SIGKILL');
        } catch {}
      }
      // Wait up to 2s for processes to die
      await new Promise(res => setTimeout(res, 500));
    }
  } catch {}

  // Also kill via our own tracking if we have a pid
  const s = activeStreams.get(id);
  if (s && s.process && !s.process.killed) {
    try { s.process.kill('SIGKILL'); } catch {}
    await new Promise(res => setTimeout(res, 300));
  }
}

// ── Clean HLS directory ───────────────────────────────────────────────────────
function cleanStreamDir(id) {
  const dir = getStreamDir(id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try {
    fs.readdirSync(dir).forEach(f => {
      if (f.endsWith('.ts') || f.endsWith('.m3u8') || f.endsWith('.tmp'))
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
    });
  } catch {}
}

// ── URL auth builder ──────────────────────────────────────────────────────────
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

// ── Video filter (pixel-accurate aspect ratio + black bars) ──────────────────
function buildVideoFilter(resolution, windowW, windowH, pixelDims) {
  const h = parseInt(resolution) || 1080;
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
  const transport = camera.transport  || 'tcp';
  const resolution = camera.resolution || '1080';
  const bitrate   = parseInt(camera.bitrate) || 2500;
  const playlist  = path.join(dir, 'stream.m3u8');

  const videoArgs = resolution === 'source'
    ? ['-c:v', 'copy']
    : [
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
        ...buildVideoFilter(resolution, camera.windowW, camera.windowH, camera._pixelDims),
        '-b:v', `${bitrate}k`, '-maxrate', `${bitrate}k`,
        '-bufsize', `${bitrate * 2}k`,
        '-g', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
      ];

  return [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-rtsp_transport', transport,
    '-rtbufsize', '512k',
    '-i', url,
    ...videoArgs,
    '-c:a', 'aac', '-b:a', '96k', '-ac', '1',
    '-f', 'hls',
    '-hls_time', '2',          // 2s segments — more stable than 1s under CPU load
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+append_list+omit_endlist+split_by_time',
    '-hls_segment_type', 'mpegts',
    '-hls_allow_cache', '0',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    playlist
  ];
}

// ── Start stream (with duplicate guard + backoff) ─────────────────────────────
async function startStream(camera) {
  const { id } = camera;
  const url = buildAuthUrl(camera.url, camera.username, camera.password);
  cameraRegistry.set(id, camera);

  if (activeStreams.has(id)) {
    activeStreams.get(id).clients++;
    console.log(`[stream] Reusing: ${id} (clients: ${activeStreams.get(id).clients})`);
    return;
  }

  // Kill any stale processes before starting fresh
  await killExistingForStream(id);
  cleanStreamDir(id);

  const dir = getStreamDir(id);
  const args = buildFfmpegArgs(camera, url, dir);

  console.log(`[stream] Starting: ${id} (crash count: ${crashCounts.get(id) || 0})`);
  const proc = spawn('ffmpeg', args, { detached: false });

  proc.stderr.on('data', d => {
    const line = d.toString().trim();
    if (line) console.log(`[ffmpeg:${id}] ${line}`);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[stream] Stopped: ${id} (code ${code}, signal ${signal})`);
    activeStreams.delete(id);
    io.emit('stream:stopped', { id });

    // Increment crash count; reset after a clean long run
    const count = (crashCounts.get(id) || 0) + 1;
    crashCounts.set(id, count);

    // Auto-restart with backoff — only if there are still clients watching
    const delay = getBackoff(id);
    console.log(`[stream] Will restart ${id} in ${delay}ms (attempt ${count})`);

    setTimeout(async () => {
      // Double-check clients still care
      if (io.sockets.sockets.size === 0) {
        console.log(`[stream] No clients — skipping restart of ${id}`);
        return;
      }
      const cam = cameraRegistry.get(id);
      if (cam) await startStream(cam);
    }, delay);
  });

  activeStreams.set(id, {
    process: proc, clients: 1, startedAt: Date.now(), camera, pid: proc.pid
  });

  // Reset crash count after 60s of stable uptime
  const stableTimer = setTimeout(() => {
    if (activeStreams.has(id)) {
      crashCounts.set(id, 0);
      console.log(`[stream] ${id} stable — reset crash count`);
    }
  }, 60000);
  stableTimer.unref();

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
  }, 15000);
}

function stopStream(id) {
  const s = activeStreams.get(id);
  if (!s) return;
  s.clients = Math.max(0, s.clients - 1);
  if (s.clients <= 0) {
    console.log(`[stream] Stopping: ${id}`);
    try { s.process.kill('SIGTERM'); } catch {}
    activeStreams.delete(id);
    crashCounts.delete(id); // reset on intentional stop
  }
}

// ── CPU watchdog ──────────────────────────────────────────────────────────────
// Check every 30s. If any ffmpeg process exceeds 150% CPU for two consecutive
// checks, kill it — it's stuck in a crash loop burning CPU.
const cpuWatchCounts = new Map();

setInterval(() => {
  for (const [id, s] of activeStreams) {
    try {
      const stat = fs.readFileSync(`/proc/${s.pid}/stat`, 'utf8').split(' ');
      // utime + stime in clock ticks
      const ticks = parseInt(stat[13]) + parseInt(stat[14]);
      const prev  = cpuWatchCounts.get(id + '_ticks') || 0;
      const delta = ticks - prev;
      cpuWatchCounts.set(id + '_ticks', ticks);

      // 30s interval, 100 ticks/s → 3000 ticks = 100% for 30s
      // 4500 ticks = 150% CPU average over 30s
      if (prev > 0 && delta > 4500) {
        const consec = (cpuWatchCounts.get(id + '_high') || 0) + 1;
        cpuWatchCounts.set(id + '_high', consec);
        console.warn(`[watchdog] ${id} high CPU (${delta} ticks, count ${consec})`);
        if (consec >= 2) {
          console.warn(`[watchdog] Killing runaway ffmpeg: ${id} pid ${s.pid}`);
          try { s.process.kill('SIGKILL'); } catch {}
          cpuWatchCounts.set(id + '_high', 0);
        }
      } else {
        cpuWatchCounts.set(id + '_high', 0);
      }
    } catch {} // process may have exited
  }
}, 30000);

// ── Disk space guard ──────────────────────────────────────────────────────────
// Check HLS dir disk usage every 60s. If >90% full, stop all streams and alert.
setInterval(() => {
  try {
    const stat = fs.statfsSync ? fs.statfsSync(HLS_DIR) : null;
    if (!stat) return;
    const pct = (1 - stat.bfree / stat.blocks) * 100;
    if (pct > 90) {
      console.error(`[disk] HLS partition ${pct.toFixed(0)}% full — stopping streams`);
      io.emit('system:warning', { message: `Disk ${pct.toFixed(0)}% full — streams paused` });
      for (const [id] of activeStreams) stopStream(id);
    }
  } catch {}
}, 60000);

// ── Pre-warm default page ─────────────────────────────────────────────────────
function prewarmDefaultPage() {
  const config  = loadConfig();
  const layouts = loadLayouts();
  const pageName = config.defaultPage || Object.keys(layouts)[0];
  if (!pageName || !layouts[pageName]) return;
  const layout = layouts[pageName];
  console.log(`[prewarm] Starting streams for default page: ${pageName}`);
  for (const win of (layout.windows || [])) {
    const cam = (layout.cameras || []).find(c => c.id === (win.cameraId || win.id));
    if (cam) startStream({ ...cam, windowW: win.w, windowH: win.h });
  }
}

// ── API ──────────────────────────────────────────────────────────────────────

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
  const { url, transport, username, password, resolution, bitrate, windowW, windowH, _pixelDims } = req.body;
  if (!url) return res.status(400).json({ error:'url required' });
  await startStream({ id:req.params.cameraId, url, transport, username, password,
    resolution, bitrate, windowW, windowH, _pixelDims });
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
      hlsUrl:`/hls/${id}/stream.m3u8`, crashes: crashCounts.get(id) || 0 };
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
      const fetch = (path2) => new Promise(resolve => {
        const req2 = https.get({
          hostname: path2.host, path: path2.path,
          headers: { 'User-Agent': 'webcameras' }, timeout: 5000
        }, r => {
          let d = ''; r.on('data', x => d += x);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        });
        req2.on('error', () => resolve(null));
        req2.on('timeout', () => { req2.destroy(); resolve(null); });
      });
      const rel = await fetch({ host:'api.github.com', path:`/repos/${repo}/releases/latest` });
      latest = rel?.tag_name?.replace(/^v/,'') || null;
      if (!latest) {
        const p = await fetch({ host:'raw.githubusercontent.com', path:`/${repo}/main/package.json` });
        latest = p?.version || null;
      }
    }
  } catch {}
  res.json({ version:local, latest, repo, upToDate: latest ? local===latest : null });
});

// ── Disk space API ────────────────────────────────────────────────────────────
app.get('/api/system', (req, res) => {
  const info = { hlsDir: HLS_DIR, streams: activeStreams.size };
  try {
    const du = execSync(`df -h "${HLS_DIR}" | tail -1`, { timeout:2000 }).toString().trim().split(/\s+/);
    info.disk = { size:du[1], used:du[2], avail:du[3], pct:du[4] };
  } catch {}
  res.json(info);
});

app.get('/config', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/config.html')));
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[ws] Client connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[ws] Disconnected: ${socket.id}`));
});

chokidar.watch(CONFIG_PATH, { ignoreInitial:true }).on('all', (_, p) => {
  console.log(`[config] Changed: ${path.basename(p)}`);
  invalidateCache(); refreshCameraRegistry();
  io.emit('layouts:updated');
});

// ── Startup ──────────────────────────────────────────────────────────────────
refreshCameraRegistry();
setTimeout(prewarmDefaultPage, 3000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  WebCameras ${pkg.version} — port ${PORT}      ║`);
  console.log(`║  HLS dir: ${HLS_DIR}  ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});

process.on('SIGTERM', () => {
  console.log('[shutdown] Stopping all streams...');
  for (const [id] of activeStreams) stopStream(id);
  server.close(() => process.exit(0));
});
