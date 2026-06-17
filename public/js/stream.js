/**
 * StreamManager — handles HLS.js playback lifecycle for camera feeds.
 *
 * Strategy:
 *   1. Request the server to start transcoding RTSP → HLS
 *   2. Use HLS.js to play the resulting m3u8 playlist
 *   3. Fall back to native <video src> for mjpeg:// or direct http streams
 *   4. Retry on error with exponential backoff
 */

import { LayoutManager } from './layout.js';

const hlsInstances = new Map();  // cameraId → Hls instance
const retryTimers  = new Map();  // cameraId → timer
const MAX_RETRIES  = 5;

export const StreamManager = {

  /** Start streaming a camera into a video element */
  async attach(camera, videoEl, overlayEl) {
    const { id, url, type } = camera;
    this.detach(id);

    if (!url) {
      LayoutManager.onStreamError(id, 'No URL configured');
      return;
    }

    // MJPEG or direct HTTP — use native img/video
    if (url.startsWith('http') && (type === 'mjpeg' || url.includes('mjpeg') || url.includes('/video'))) {
      this._attachMjpeg(camera, videoEl, overlayEl);
      return;
    }

    // HLS direct URL (.m3u8) — use HLS.js directly without server transcoding
    if (url.endsWith('.m3u8') || url.startsWith('http')) {
      this._attachHls(id, url, videoEl, overlayEl);
      return;
    }

    // RTSP → start server-side HLS transcoding
    if (url.startsWith('rtsp://') || url.startsWith('rtsps://')) {
      try {
        const resp = await fetch(`/api/streams/${encodeURIComponent(id)}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, transport: camera.transport || 'tcp' })
        });
        const data = await resp.json();
        if (data.hlsUrl) {
          // Poll until playlist file appears, then attach HLS
          this._waitForHls(id, data.hlsUrl, videoEl, overlayEl);
        }
      } catch (e) {
        LayoutManager.onStreamError(id, 'Server error: ' + e.message);
      }
      return;
    }

    LayoutManager.onStreamError(id, 'Unsupported URL scheme');
  },

  /** Wait for the HLS playlist to appear on the server */
  _waitForHls(id, hlsUrl, videoEl, overlayEl, attempts = 0) {
    if (attempts > 20) {
      LayoutManager.onStreamError(id, 'Stream timeout');
      return;
    }
    setTimeout(async () => {
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
  },

  /** HLS.js attachment */
  _attachHls(id, hlsUrl, videoEl, overlayEl, retryCount = 0) {
    if (Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode:    true,
        liveSyncDuration:  2,
        liveMaxLatencyDuration: 6,
        maxBufferLength:   10,
        startLevel:        -1,
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoEl.play().catch(() => {});
        LayoutManager.onStreamReady(id);
        retryTimers.delete(id);
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          if (retryCount < MAX_RETRIES) {
            console.warn(`[stream] HLS error on ${id}, retrying (${retryCount + 1}/${MAX_RETRIES})…`);
            hls.destroy();
            hlsInstances.delete(id);
            const t = setTimeout(() => this._attachHls(id, hlsUrl, videoEl, overlayEl, retryCount + 1),
              Math.min(2000 * (retryCount + 1), 10000));
            retryTimers.set(id, t);
          } else {
            LayoutManager.onStreamError(id, 'Feed lost — retrying…');
            hls.destroy();
            const t = setTimeout(() => this._attachHls(id, hlsUrl, videoEl, overlayEl, 0), 15000);
            retryTimers.set(id, t);
          }
        }
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(videoEl);
      hlsInstances.set(id, hls);
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari)
      videoEl.src = hlsUrl;
      videoEl.addEventListener('loadedmetadata', () => {
        videoEl.play().catch(() => {});
        LayoutManager.onStreamReady(id);
      });
    } else {
      LayoutManager.onStreamError(id, 'HLS not supported in this browser');
    }
  },

  /** MJPEG attachment using <img> element inside video placeholder */
  _attachMjpeg(camera, videoEl, overlayEl) {
    const { id, url } = camera;
    const img = document.createElement('img');
    img.src = url;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    img.onload = () => LayoutManager.onStreamReady(id);
    img.onerror = () => LayoutManager.onStreamError(id, 'MJPEG connection failed');
    videoEl.parentNode.insertBefore(img, videoEl);
    videoEl.style.display = 'none';
  },

  /** Stop and clean up a camera stream */
  detach(id) {
    // Clear retry timers
    if (retryTimers.has(id)) {
      clearTimeout(retryTimers.get(id));
      retryTimers.delete(id);
    }
    // Destroy HLS instance
    if (hlsInstances.has(id)) {
      hlsInstances.get(id).destroy();
      hlsInstances.delete(id);
    }
    // Tell server to stop transcoding
    fetch(`/api/streams/${encodeURIComponent(id)}/stop`, { method: 'POST' }).catch(() => {});
  },

  onReady(id) { LayoutManager.onStreamReady(id); },
  onStopped(id) { LayoutManager.onStreamError(id, 'Stream stopped'); },

  // ─── Fullscreen ───────────────────────────────────────────────────────────

  _fsHls: null,

  openFullscreen(camera, sourceVideo) {
    const { id, url } = camera;
    const fsEl   = document.getElementById('cam-fullscreen');
    const fsVid  = document.getElementById('cam-fs-video');
    const fsLbl  = document.getElementById('cam-fs-label');

    fsEl.classList.remove('hidden');
    fsLbl.textContent = camera.label || id;

    // Determine HLS URL
    const hlsUrl = url.endsWith('.m3u8') || url.startsWith('http')
      ? url
      : `/hls/${encodeURIComponent(id)}/stream.m3u8`;

    if (Hls.isSupported()) {
      if (this._fsHls) { this._fsHls.destroy(); }
      const hls = new Hls({ lowLatencyMode: true });
      hls.loadSource(hlsUrl);
      hls.attachMedia(fsVid);
      hls.on(Hls.Events.MANIFEST_PARSED, () => fsVid.play().catch(() => {}));
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
    if (this._fsHls) { this._fsHls.destroy(); this._fsHls = null; }
  },
};
