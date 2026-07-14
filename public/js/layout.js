/**
 * LayoutManager — renders camera windows according to layout definitions.
 *
 * Layout window positions use a ratio-based coordinate system:
 *   x, y   → 0.0–1.0 as fraction of the container width/height
 *   w, h   → 0.0–1.0 as fraction of the container width/height
 *
 * This keeps layouts display-resolution independent.
 *
 * Example window: { x:0, y:0, w:0.5, h:0.5, cameraId:"front-door", label:"Front Door" }
 */

import { StreamManager } from './stream.js';
import { state }         from './app.js';

export const LayoutManager = {

  /** Currently rendered cells: Map<cameraId, {el, video}> */
  _cells: new Map(),

  /** Render the named layout page into #camera-grid */
  render(pageName) {
    const layout = state.layouts[pageName];
    if (!layout) return;

    const grid = document.getElementById('camera-grid');
    const windows = layout.windows || [];

    // Stop all existing streams & clear grid
    for (const [id] of this._cells) StreamManager.detach(id);
    this._cells.clear();
    grid.innerHTML = '';

    if (windows.length === 0) return;

    for (const win of windows) {
      const cell = this._createCell(win);
      grid.appendChild(cell.el);
      this._cells.set(win.cameraId || win.id, cell);

      // Find camera config and start stream
      // Measure actual pixel dimensions AFTER appending to DOM so the server
      // can compute the correct target aspect ratio for black bar padding.
      const cam = this._findCamera(win.cameraId || win.id, layout);
      if (cam) {
        // Use requestAnimationFrame to ensure the element has been laid out
        requestAnimationFrame(() => {
          const rect = cell.el.getBoundingClientRect();
          const pixW = rect.width  || (grid.offsetWidth  * win.w);
          const pixH = rect.height || (grid.offsetHeight * win.h);
          StreamManager.attach(
            { ...cam, windowW: pixW, windowH: pixH, _pixelDims: true },
            cell.video,
            cell.overlay
          );
        });
      }
    }
  },

  /** Create a positioned camera cell element */
  _createCell(win) {
    const el = document.createElement('div');
    el.className = 'cam-cell';
    el.dataset.camId = win.cameraId || win.id || '';

    // Ratio-based absolute positioning
    el.style.left   = (win.x * 100) + '%';
    el.style.top    = (win.y * 100) + '%';
    el.style.width  = (win.w * 100) + '%';
    el.style.height = (win.h * 100) + '%';

    // Gap between cells
    el.style.padding = '1.5px';

    const video = document.createElement('video');
    video.autoplay  = true;
    video.muted     = true;
    video.playsInline = true;
    video.controls  = false;
    video.preload   = 'none';   // don't speculatively buffer before HLS.js attaches
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;background:#000';

    // Loading overlay
    const overlay = document.createElement('div');
    overlay.className = 'cam-overlay loading';
    overlay.innerHTML = `
      <div class="cam-spinner"></div>
      <div class="cam-status-text">Connecting…</div>`;

    // Label bar
    const label = document.createElement('div');
    label.className = 'cam-label';
    label.innerHTML = `
      <span class="cam-name">${win.label || win.cameraId || 'Camera'}</span>
      <span class="cam-time"></span>`;

    // Live recording dot
    const recDot = document.createElement('div');
    recDot.className = 'cam-rec-dot';
    recDot.style.display = 'none';

    el.appendChild(video);
    el.appendChild(overlay);
    el.appendChild(label);
    el.appendChild(recDot);

    // Click → fullscreen
    el.addEventListener('click', () => {
      const cam = this._findCamera(win.cameraId || win.id, state.layouts[state.currentPage]);
      if (cam) StreamManager.openFullscreen(cam, video);
    });

    // Tick the timestamp
    setInterval(() => {
      const t = label.querySelector('.cam-time');
      if (t) t.textContent = new Date().toLocaleTimeString();
    }, 1000);

    return { el, video, overlay, recDot, label };
  },

  /** Find camera object by id within layout or global camera list */
  _findCamera(id, layout) {
    if (!id) return null;
    // First check layout-local cameras
    const local = (layout?.cameras || []).find(c => c.id === id);
    if (local) return local;
    // Check all layouts for this camera (global registry pattern)
    for (const l of Object.values(state.layouts)) {
      const c = (l.cameras || []).find(c => c.id === id);
      if (c) return c;
    }
    return null;
  },

  /** Called when a stream becomes ready — show the video, hide overlay */
  onStreamReady(id) {
    const cell = this._cells.get(id);
    if (!cell) return;
    cell.overlay.style.display = 'none';
    cell.recDot.style.display = '';
  },

  /** Called when a stream errors */
  onStreamError(id, msg) {
    const cell = this._cells.get(id);
    if (!cell) return;
    cell.overlay.className = 'cam-overlay error';
    cell.overlay.innerHTML = `
      <div class="cam-err-icon">⚠</div>
      <div class="cam-status-text">${msg || 'Stream error'}</div>`;
  },

};
