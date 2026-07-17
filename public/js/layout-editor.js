/**
 * LayoutEditor — full layout editing UI with:
 *  - Window list (add / remove / configure)
 *  - Ratio-based position & size inputs (x, y, w, h as 0–1 fractions)
 *  - Live preview grid
 *  - Camera assignment per window
 *  - Drag-to-position in preview
 */

import { state, renderPageTabs, switchPage } from './app.js';
import { Modal } from './settings.js';
import { Toast } from './toast.js';

export const LayoutEditor = {

  _name: null,
  _layout: null,
  _windows: [],
  _selectedWin: null,

  open(name, layout) {
    this._name = name;
    this._layout = JSON.parse(JSON.stringify(layout)); // deep clone
    this._windows = this._layout.windows || [];
    this._selectedWin = null;

    Modal.open(`Edit Layout: ${layout.label || name}`, this._buildHtml());
    this._bindEvents();
    this._renderWindowList();
    this._renderPreview();
  },

  _buildHtml() {
    return `
<div class="layout-editor">

  <!-- Preview -->
  <div class="layout-section">
    <h4>Preview <span style="font-size:10px;color:var(--text-dim);font-weight:400">(click window to select)</span></h4>
    <div class="preview-grid-wrap">
      <div class="preview-ratio-pad"></div>
      <div class="preview-grid-inner" id="le-preview"></div>
    </div>
  </div>

  <!-- Label -->
  <div class="layout-section">
    <label style="flex-direction:row;align-items:center;gap:8px;font-size:13px">
      <span style="white-space:nowrap;color:var(--text-muted);min-width:80px">Page Label</span>
      <input type="text" id="le-label" value="${this._layout.label || this._name}"
        style="flex:1;background:var(--surface2);border:1px solid var(--border);
               border-radius:4px;padding:6px 10px;color:var(--text);font-size:13px">
    </label>
  </div>

  <!-- Window list -->
  <div class="layout-section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <h4>Windows</h4>
      <button id="le-add-win" style="
        padding:4px 10px;font-size:12px;border-radius:4px;
        border:1px solid var(--border);background:var(--surface3);
        color:var(--text-muted);cursor:pointer">+ Add Window</button>
    </div>
    <div id="le-window-list" class="window-list"></div>
  </div>

  <!-- Actions -->
  <div style="display:flex;gap:8px;padding-top:4px">
    <button id="le-save" class="btn-primary">Save Layout</button>
    <button id="le-cancel" style="
      padding:8px 14px;border:1px solid var(--border);border-radius:4px;
      background:var(--surface3);color:var(--text-muted);font-size:13px;cursor:pointer">
      Cancel
    </button>
  </div>
</div>`;
  },

  _bindEvents() {
    document.getElementById('le-add-win').addEventListener('click', () => {
      const id = 'w' + (Date.now() % 100000);
      this._windows.push({ id, x: 0, y: 0, w: 0.5, h: 0.5, cameraId: '', label: 'New Window', showLabel: true });
      this._renderWindowList();
      this._renderPreview();
    });

    document.getElementById('le-save').addEventListener('click', async () => {
      this._layout.label   = document.getElementById('le-label').value.trim() || this._name;
      this._layout.windows = this._windows;
      await fetch(`/api/layouts/${encodeURIComponent(this._name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._layout)
      });
      state.layouts[this._name] = this._layout;
      renderPageTabs();
      if (state.currentPage === this._name) switchPage(this._name);
      Modal.close();
      Toast.show('Layout saved', 'success');
    });

    document.getElementById('le-cancel').addEventListener('click', () => Modal.close());
  },

  // ─── Window List ───────────────────────────────────────────────────────────

  _renderWindowList() {
    const list = document.getElementById('le-window-list');
    if (!list) return;
    list.innerHTML = '';

    if (this._windows.length === 0) {
      list.innerHTML = `<p style="font-size:12px;color:var(--text-muted);padding:8px 0">
        No windows. Add one above.</p>`;
      return;
    }

    const allCams = this._getAllCameras();
    const camOptions = allCams.map(c =>
      `<option value="${c.id}">${c.label || c.id}</option>`).join('');

    this._windows.forEach((win, idx) => {
      const row = document.createElement('div');
      row.className = 'window-row' + (this._selectedWin === idx ? ' selected' : '');
      row.style.borderColor = this._selectedWin === idx ? 'var(--accent-dim)' : '';

      row.innerHTML = `
        <div class="window-row-header">
          <span class="window-row-label">Window ${idx + 1}</span>
          <button class="win-del" data-idx="${idx}" style="
            font-size:11px;padding:2px 7px;border-radius:3px;
            border:1px solid var(--border);background:var(--surface3);
            color:var(--text-muted);cursor:pointer">Remove</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <label style="font-size:11px;color:var(--text-muted);flex:1;margin:0">Label
            <input type="text" class="win-field" data-idx="${idx}" data-field="label"
              value="${win.label || ''}" placeholder="Window label">
          </label>
          <label style="font-size:11px;color:var(--text-muted);white-space:nowrap;display:flex;align-items:center;gap:4px;margin:0;padding-top:14px">
            <input type="checkbox" class="win-show-label" data-idx="${idx}"
              ${win.showLabel !== false ? 'checked' : ''}
              style="width:14px;height:14px;accent-color:var(--accent);cursor:pointer">
            Show
          </label>
        </div>
        <label style="font-size:11px;color:var(--text-muted)">Camera
          <select class="win-cam-select" data-idx="${idx}">
            <option value="">— Unassigned —</option>
            ${camOptions}
          </select>
        </label>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
          Position &amp; Size <span style="font-size:10px">(0.0–1.0 fraction of screen)</span>
        </div>
        <div class="window-grid">
          <label>X (left)
            <input type="number" class="win-field" data-idx="${idx}" data-field="x"
              min="0" max="1" step="0.01" value="${this._fmt(win.x)}">
          </label>
          <label>Y (top)
            <input type="number" class="win-field" data-idx="${idx}" data-field="y"
              min="0" max="1" step="0.01" value="${this._fmt(win.y)}">
          </label>
          <label>W (width)
            <input type="number" class="win-field" data-idx="${idx}" data-field="w"
              min="0.01" max="1" step="0.01" value="${this._fmt(win.w)}">
          </label>
          <label>H (height)
            <input type="number" class="win-field" data-idx="${idx}" data-field="h"
              min="0.01" max="1" step="0.01" value="${this._fmt(win.h)}">
          </label>
        </div>`;

      // Set camera select value
      const sel = row.querySelector('.win-cam-select');
      sel.value = win.cameraId || '';
      sel.addEventListener('change', (e) => {
        this._windows[idx].cameraId = e.target.value;
        // Auto-set label from camera if blank
        if (!this._windows[idx].label || this._windows[idx].label === 'New Window') {
          const cam = allCams.find(c => c.id === e.target.value);
          if (cam) {
            this._windows[idx].label = cam.label || cam.id;
            row.querySelector('[data-field="label"]').value = this._windows[idx].label;
          }
        }
        this._renderPreview();
      });

      // Field changes
      row.querySelectorAll('.win-field').forEach(input => {
        input.addEventListener('input', (e) => {
          const field = e.target.dataset.field;
          const val   = field === 'label' ? e.target.value : parseFloat(e.target.value);
          if (field !== 'label' && (isNaN(val) || val < 0)) return;
          this._windows[idx][field] = val;
          this._renderPreview();
        });
      });

      // showLabel toggle
      const showLabelCb = row.querySelector('.win-show-label');
      if (showLabelCb) {
        showLabelCb.addEventListener('change', (e) => {
          this._windows[idx].showLabel = e.target.checked;
          this._renderPreview();
        });
      }

      // Delete
      row.querySelector('.win-del').addEventListener('click', () => {
        this._windows.splice(idx, 1);
        if (this._selectedWin === idx) this._selectedWin = null;
        this._renderWindowList();
        this._renderPreview();
      });

      // Select on click
      row.addEventListener('click', () => {
        this._selectedWin = idx;
        this._renderWindowList();
        this._renderPreview();
      });

      list.appendChild(row);
    });
  },

  // ─── Preview Grid ──────────────────────────────────────────────────────────

  _renderPreview() {
    const preview = document.getElementById('le-preview');
    if (!preview) return;
    preview.innerHTML = '';

    this._windows.forEach((win, idx) => {
      const el = document.createElement('div');
      el.className = 'preview-window' + (this._selectedWin === idx ? ' active' : '');
      el.style.left   = (win.x * 100) + '%';
      el.style.top    = (win.y * 100) + '%';
      el.style.width  = (win.w * 100) + '%';
      el.style.height = (win.h * 100) + '%';
      el.title = win.label || `Window ${idx + 1}`;
      const labelText = win.label || win.cameraId || `Win ${idx+1}`;
      const showL = win.showLabel !== false;
      el.innerHTML = `<span style="font-size:9px;text-align:center;padding:2px;
        overflow:hidden;max-width:100%;white-space:nowrap;text-overflow:ellipsis;
        opacity:${showL ? '1' : '0.3'};text-decoration:${showL ? 'none' : 'line-through'}">
        ${labelText}${showL ? '' : ' 🚫'}
      </span>`;

      // Drag to reposition
      this._makeDraggable(el, idx, preview);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this._selectedWin = idx;
        this._renderWindowList();
        this._renderPreview();
      });

      preview.appendChild(el);
    });
  },

  _makeDraggable(el, idx, container) {
    let startX, startY, startWinX, startWinY;

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._selectedWin = idx;
      const rect = container.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startWinX = this._windows[idx].x;
      startWinY = this._windows[idx].y;

      const onMove = (me) => {
        const dx = (me.clientX - startX) / rect.width;
        const dy = (me.clientY - startY) / rect.height;
        const win = this._windows[idx];
        win.x = Math.max(0, Math.min(1 - win.w, startWinX + dx));
        win.y = Math.max(0, Math.min(1 - win.h, startWinY + dy));
        // Update preview el directly for performance
        el.style.left = (win.x * 100) + '%';
        el.style.top  = (win.y * 100) + '%';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this._renderWindowList(); // sync input fields
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Touch support
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect = container.getBoundingClientRect();
      startX = touch.clientX;
      startY = touch.clientY;
      startWinX = this._windows[idx].x;
      startWinY = this._windows[idx].y;

      const onMove = (te) => {
        const t = te.touches[0];
        const dx = (t.clientX - startX) / rect.width;
        const dy = (t.clientY - startY) / rect.height;
        const win = this._windows[idx];
        win.x = Math.max(0, Math.min(1 - win.w, startWinX + dx));
        win.y = Math.max(0, Math.min(1 - win.h, startWinY + dy));
        el.style.left = (win.x * 100) + '%';
        el.style.top  = (win.y * 100) + '%';
      };
      const onEnd = () => {
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        this._renderWindowList();
      };
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    }, { passive: false });
  },

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _fmt(n) { return typeof n === 'number' ? n.toFixed(3) : '0.000'; },

  _getAllCameras() {
    const seen = new Set();
    const cams = [];
    for (const layout of Object.values(state.layouts)) {
      for (const cam of layout.cameras || []) {
        if (!seen.has(cam.id)) { seen.add(cam.id); cams.push(cam); }
      }
    }
    return cams;
  },
};
