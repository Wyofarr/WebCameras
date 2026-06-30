/**
 * StreamManager — HLS.js playback + RTSP→HLS lifecycle
 */

import { LayoutManager } from './layout.js';

const hlsInstances  = new Map();  // id → Hls instance
const retryTimers   = new Map();  // id → timer
const cameraStore   = new Map();  // id → camera object (so we can restart cleanly)
const videoStore    = new Map();  // id → videoEl
const overlayStore  = new Map();  // id → overlayEl
const MAX_RETRIES   = 5;

export const StreamManager = {

  async attach(camera, videoEl, overlayEl) {
    const { id, url, type } = camera;

    // Store refs for restart
    cameraStore.set(id, camera);
    videoStore.set(id, videoEl);
    overlayStore.set(id, overlayEl);

    this.detach(id);

    if (!url) {
      LayoutManager.onStreamError(id, 'No URL configured');
      return;
    }

    // MJPEG
    if (type === 'mjpeg' || (url.startsWith('http') &&
        (url.includes('mjpeg') || url.includes('/video')))) {
      this._attachMjpeg(camera, videoEl, overlayEl);
      return;
    }

    // Direct HLS
    if (url.endsWith('.m3u8')) {
      this._attachHls(id, url, videoEl, overlayEl);
      return;
    }

    // RTSP → server transcode
    if (url.startsWith('rtsp://') || url.startsWith('rtsps://')) {
      try {
        const resp = await fetch(`/api/streams/${encodeURIComponent(id)}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url,
            transport:  camera.transport  || 'tcp',
            username:   camera.username   || '',
            password:   camera.password   || '',
            resolution: camera.resolution || '1080',
            bitrate:    camera.bitrate    || '2500',
            windowW:    camera.windowW    || null,
            windowH:    camera.windowH    || null,
          })
        });
        const data = await resp.json();
        if (data.hlsUrl) {
          this._waitForHls(id, data.hlsUrl, videoEl, overlayEl);
        }
      } catch (e) {
        LayoutManager.onStreamError(id, 'Server error: ' + e.message);
      }
      return;
    }

    // HTTP stream — try HLS.js
    if (url.startsWith('http')) {
      this._attachHls(id, url, videoEl, overlayEl);
      return;
    }

    LayoutManager.onStreamError(id, 'Unsupported URL scheme');
  },

  // Poll until m3u8 exists (server signals via socket too, but this is a fallback)
  _waitForHls(id, hlsUrl, videoEl, overlayEl, attempts = 0) {
    if (attempts > 30) {
      LayoutManager.onStreamError(id, 'Stream startup timed out');
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(hlsUrl, { method: 'HEAD', cache: 'no-store' });
        if (r.ok) {
          this._attachHls(id, hlsUrl, videoEl, overlayEl);
        } else {
          this._waitForHls(id, hlsUrl, videoEl, overlayEl, attempts + 1);
        }
      } catch {
        this._waitForHls(id, hlsUrl, videoEl, overlayEl, attempts + 1);
      }
    }, 500);
    retryTimers.set(id + '_wait', t);
  },

  _attachHls(id, hlsUrl, videoEl, overlayEl, retryCount = 0) {
    if (!Hls.isSupported()) {
      // Safari native HLS
      if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        videoEl.src = hlsUrl;
        videoEl.addEventListener('loadedmetadata', () => {
          videoEl.play().catch(() => {});
          LayoutManager.onStreamReady(id);
        }, { once: true });
      } else {
        LayoutManager.onStreamError(id, 'HLS not supported');
      }
      return;
    }

    const hls = new Hls({
      lowLatencyMode:             true,
      liveSyncDuration:           1,
      liveMaxLatencyDuration:     4,
      maxBufferLength:            6,
      maxMaxBufferLength:         12,
      startLevel:                 -1,
      manifestLoadingTimeOut:     8000,
      manifestLoadingMaxRetry:    8,
      manifestLoadingRetryDelay:  500,
      levelLoadingTimeOut:        8000,
      fragLoadingTimeOut:         12000,
      fragLoadingMaxRetry:        6,
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      videoEl.play().catch(() => {});
      LayoutManager.onStreamReady(id);
      retryTimers.delete(id);
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      console.warn(`[stream] Fatal HLS error on ${id}: ${data.type} / ${data.details}`);
      hls.destroy();
      hlsInstances.delete(id);

      if (retryCount < MAX_RETRIES) {
        const delay = Math.min(1500 * (retryCount + 1), 8000);
        console.log(`[stream] Retrying ${id} in ${delay}ms (${retryCount+1}/${MAX_RETRIES})`);
        const t = setTimeout(() => {
          // Re-fetch the hlsUrl in case segments rolled over
          this._attachHls(id, hlsUrl, videoEl, overlayEl, retryCount + 1);
        }, delay);
        retryTimers.set(id, t);
      } else {
        // Max retries hit — show error and do a slow retry
        LayoutManager.onStreamError(id, 'Feed lost — retrying…');
        const t = setTimeout(() => {
          // Full restart: tell server to restart ffmpeg, then reattach
          const cam = cameraStore.get(id);
          const vid = videoStore.get(id);
          const ov  = overlayStore.get(id);
          if (cam && vid) {
            console.log(`[stream] Full restart: ${id}`);
            this.attach(cam, vid, ov);
          }
        }, 10000);
        retryTimers.set(id, t);
      }
    });

    hls.loadSource(hlsUrl);
    hls.attachMedia(videoEl);
    hlsInstances.set(id, hls);
  },

  _attachMjpeg(camera, videoEl, overlayEl) {
    const { id, url } = camera;
    const img = document.createElement('img');
    img.src = url;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    img.onload  = () => LayoutManager.onStreamReady(id);
    img.onerror = () => LayoutManager.onStreamError(id, 'MJPEG connection failed');
    videoEl.parentNode.insertBefore(img, videoEl);
    videoEl.style.display = 'none';
  },

  detach(id) {
    // Clear all timers for this id
    for (const key of [id, id + '_wait']) {
      if (retryTimers.has(key)) {
        clearTimeout(retryTimers.get(key));
        retryTimers.delete(key);
      }
    }
    if (hlsInstances.has(id)) {
      try { hlsInstances.get(id).destroy(); } catch {}
      hlsInstances.delete(id);
    }
    fetch(`/api/streams/${encodeURIComponent(id)}/stop`, { method:'POST' }).catch(() => {});
  },

  // Called by socket event when server signals stream is ready
  onReady(id) {
    LayoutManager.onStreamReady(id);
    // If HLS.js is waiting, prod it to retry immediately
    const hls = hlsInstances.get(id);
    if (hls) {
      try { hls.startLoad(); } catch {}
    }
  },

  onStopped(id) {
    // Server stopped the stream — it will auto-restart
    // Just update the UI, don't destroy HLS.js — it will reconnect
    LayoutManager.onStreamError(id, 'Reconnecting…');
  },

  // ─── Fullscreen ─────────────────────────────────────────────────────────────
  _fsHls: null,

  openFullscreen(camera, sourceVideo) {
    const { id, url } = camera;
    const fsEl  = document.getElementById('cam-fullscreen');
    const fsVid = document.getElementById('cam-fs-video');
    const fsLbl = document.getElementById('cam-fs-label');

    fsEl.classList.remove('hidden');
    fsLbl.textContent = camera.label || id;

    const hlsUrl = url.endsWith('.m3u8') || url.startsWith('http')
      ? url
      : `/hls/${encodeURIComponent(id)}/stream.m3u8`;

    if (Hls.isSupported()) {
      if (this._fsHls) { try { this._fsHls.destroy(); } catch {} }
      const hls = new Hls({ lowLatencyMode:true, liveSyncDuration:1 });
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
    if (this._fsHls) { try { this._fsHls.destroy(); } catch {} this._fsHls = null; }
  },
};
