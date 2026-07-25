/**
 * StreamManager — HLS.js playback only.
 *
 * In the always-on model the server keeps every configured camera
 * streaming continuously. The browser never starts or stops ffmpeg —
 * it just points HLS.js at /hls/<id>/stream.m3u8 which is always
 * being written. No /api/streams/start or /stop calls.
 */

import { LayoutManager } from './layout.js';

const hlsInstances = new Map();  // id → Hls instance
const retryTimers  = new Map();  // id → timer

export const StreamManager = {

  // ── Attach HLS.js to a camera cell ────────────────────────────────────────
  attach(camera, videoEl, overlayEl) {
    const { id, url, type } = camera;

    this.detachHls(id); // clean up any existing HLS instance

    if (!url) {
      LayoutManager.onStreamError(id, 'No URL configured');
      return;
    }

    // MJPEG — direct image stream, no HLS needed
    if (type === 'mjpeg' ||
        (url.startsWith('http') &&
         (url.includes('mjpeg') || url.includes('/video')))) {
      this._attachMjpeg(camera, videoEl);
      return;
    }

    // Direct HLS .m3u8 URL from camera (not our server)
    if (url.endsWith('.m3u8')) {
      this._attachHls(id, url, videoEl, overlayEl);
      return;
    }

    // RTSP or HTTP — server is always transcoding to HLS
    // Just point HLS.js at the segment playlist, no API call needed
    const hlsUrl = `/hls/${encodeURIComponent(id)}/stream.m3u8`;
    this._waitAndAttach(id, hlsUrl, videoEl, overlayEl);
  },

  // Poll until the m3u8 exists (server may still be starting up)
  _waitAndAttach(id, hlsUrl, videoEl, overlayEl, attempts = 0) {
    if (attempts > 40) {
      LayoutManager.onStreamError(id, 'Stream not available');
      return;
    }

    const t = setTimeout(async () => {
      try {
        const r = await fetch(hlsUrl, { method:'HEAD', cache:'no-store' });
        if (r.ok) {
          this._attachHls(id, hlsUrl, videoEl, overlayEl);
        } else {
          this._waitAndAttach(id, hlsUrl, videoEl, overlayEl, attempts + 1);
        }
      } catch {
        this._waitAndAttach(id, hlsUrl, videoEl, overlayEl, attempts + 1);
      }
    }, 500);
    retryTimers.set(id + '_wait', t);
  },

  _attachHls(id, hlsUrl, videoEl, overlayEl, retryCount = 0) {
    // Load HLS.js on demand if not yet available
    if (typeof Hls === 'undefined' && window.loadHlsJs) {
      window.loadHlsJs(() =>
        this._attachHls(id, hlsUrl, videoEl, overlayEl, retryCount));
      return;
    }

    // Safari — native HLS support
    if (!Hls.isSupported()) {
      if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        videoEl.src = hlsUrl;
        videoEl.addEventListener('loadedmetadata', () => {
          videoEl.play().catch(() => {});
          LayoutManager.onStreamReady(id);
        }, { once: true });
      } else {
        LayoutManager.onStreamError(id, 'HLS not supported in this browser');
      }
      return;
    }

    const hls = new Hls({
      lowLatencyMode:            true,
      liveSyncDuration:          2,
      liveMaxLatencyDuration:    6,
      maxBufferLength:           8,
      maxMaxBufferLength:        16,
      startLevel:                -1,
      manifestLoadingTimeOut:    10000,
      manifestLoadingMaxRetry:   10,
      manifestLoadingRetryDelay: 1000,
      levelLoadingTimeOut:       10000,
      fragLoadingTimeOut:        15000,
      fragLoadingMaxRetry:       8,
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      videoEl.play().catch(() => {});
      LayoutManager.onStreamReady(id);
      // Clear any wait timer
      const wt = retryTimers.get(id + '_wait');
      if (wt) { clearTimeout(wt); retryTimers.delete(id + '_wait'); }
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      console.warn(`[stream] HLS error ${id}: ${data.type}/${data.details}`);
      hls.destroy();
      hlsInstances.delete(id);

      // Always retry — server keeps the stream alive
      const MAX = 8;
      if (retryCount < MAX) {
        const delay = Math.min(1500 * (retryCount + 1), 10000);
        const t = setTimeout(() =>
          this._attachHls(id, hlsUrl, videoEl, overlayEl, retryCount + 1),
          delay);
        retryTimers.set(id, t);
      } else {
        LayoutManager.onStreamError(id, 'Reconnecting...');
        // Long pause then full retry from poll
        const t = setTimeout(() => {
          this._waitAndAttach(id, hlsUrl, videoEl, overlayEl);
        }, 15000);
        retryTimers.set(id, t);
      }
    });

    hls.loadSource(hlsUrl);
    hls.attachMedia(videoEl);
    hlsInstances.set(id, hls);
  },

  _attachMjpeg(camera, videoEl) {
    const { id, url } = camera;
    const img = document.createElement('img');
    img.src = url;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    img.onload  = () => LayoutManager.onStreamReady(id);
    img.onerror = () => LayoutManager.onStreamError(id, 'MJPEG unavailable');
    videoEl.parentNode.insertBefore(img, videoEl);
    videoEl.style.display = 'none';
  },

  // Detach HLS.js only — does NOT stop the server stream
  detachHls(id) {
    for (const key of [id, id + '_wait']) {
      const t = retryTimers.get(key);
      if (t) { clearTimeout(t); retryTimers.delete(key); }
    }
    const hls = hlsInstances.get(id);
    if (hls) {
      try { hls.destroy(); } catch {}
      hlsInstances.delete(id);
    }
    // No /api/streams/stop call — server keeps running
  },

  // Called by socket stream:ready — server just produced first segment
  onReady(id) {
    LayoutManager.onStreamReady(id);
    const hls = hlsInstances.get(id);
    if (hls) { try { hls.startLoad(); } catch {} }
  },

  // Called by socket stream:stopped — server crashed, will auto-restart
  // Keep HLS.js alive — it will reconnect when segments reappear
  onStopped(id) {
    LayoutManager.onStreamError(id, 'Reconnecting...');
    // Don't destroy HLS.js — just let manifest retries handle reconnect
  },

  // ── Fullscreen ─────────────────────────────────────────────────────────────
  _fsHls: null,

  openFullscreen(camera) {
    const { id, url, type } = camera;
    const fsEl  = document.getElementById('cam-fullscreen');
    const fsVid = document.getElementById('cam-fs-video');
    const fsLbl = document.getElementById('cam-fs-label');

    fsEl.classList.remove('hidden');
    fsLbl.textContent = camera.label || id;

    // Use the server HLS stream — always running
    const hlsUrl = (url.endsWith('.m3u8') || url.startsWith('http'))
      ? url
      : `/hls/${encodeURIComponent(id)}/stream.m3u8`;

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      if (this._fsHls) { try { this._fsHls.destroy(); } catch {} }
      const hls = new Hls({ lowLatencyMode:true, liveSyncDuration:2 });
      hls.loadSource(hlsUrl);
      hls.attachMedia(fsVid);
      hls.on(Hls.Events.MANIFEST_PARSED, () => fsVid.play().catch(()=>{}));
      this._fsHls = hls;
    } else {
      fsVid.src = hlsUrl;
      fsVid.play().catch(() => {});
    }
  },

  closeFullscreen() {
    const fsEl  = document.getElementById('cam-fullscreen');
    const fsVid = document.getElementById('cam-fs-video');
    fsEl.classList.add('hidden');
    fsVid.pause();
    fsVid.src = '';
    if (this._fsHls) {
      try { this._fsHls.destroy(); } catch {}
      this._fsHls = null;
    }
  },
};
