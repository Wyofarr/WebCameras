/**
 * SettingsPanel — manages the slide-in settings sidebar.
 * Handles: Camera CRUD, Layout CRUD, Global config form, Layout editor modal.
 */

import { state, renderPageTabs, switchPage } from './app.js';
import { LayoutEditor } from './layout-editor.js';
import { Toast } from './toast.js';

export const SettingsPanel = {

  _open: false,

  init() {
    // Settings nav tabs
    document.querySelectorAll('.snav').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.snav').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      });
    });

    document.getElementById('btn-close-settings').addEventListener('click', () => this.close());
    document.getElementById('btn-add-layout').addEventListener('click', () => this.promptNewLayout());

    // Global config form
    document.getElementById('form-global').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const cfg = {
        title:        fd.get('title') || 'WebCameras',
        rotate:       fd.get('rotate') === 'on',
        rotatedelay:  parseInt(fd.get('rotatedelay')) || 30,
        startsleep:   parseInt(fd.get('startsleep')) || 2,
        feedsleep:    parseInt(fd.get('feedsleep')) || 2,
        retry:        parseInt(fd.get('retry')) || 3,
      };
      await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg)
      });
      Toast.show('Global config saved', 'success');
    });

    this.refresh();
  },

  toggle() { this._open ? this.close() : this.open(); },
  open(tab) {
    this._open = true;
    const panel = document.getElementById('settings-panel');
    panel.classList.remove('hidden');
    document.getElementById('view-area').classList.add('panel-open');
    if (tab) {
      document.querySelectorAll('.snav').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
      });
      document.querySelectorAll('.stab').forEach(t => {
        t.classList.toggle('active', t.id === 'tab-' + tab);
      });
    }
  },
  close() {
    this._open = false;
    document.getElementById('settings-panel').classList.add('hidden');
    document.getElementById('view-area').classList.remove('panel-open');
  },

  refresh() {
    if (document.getElementById('camera-list')) this._renderCameraList();
    this._renderLayoutList();
    this._populateGlobalForm();
  },

  // ─── Camera List ───────────────────────────────────────────────────────────

  _getAllCameras() {
    const seen = new Set();
    const cams = [];
    for (const layout of Object.values(state.layouts)) {
      for (const cam of layout.cameras || []) {
        if (!seen.has(cam.id)) {
          seen.add(cam.id);
          cams.push({ ...cam, _layout: layout });
        }
      }
    }
    return cams;
  },

  _renderCameraList() {
    const list = document.getElementById('camera-list');
    list.innerHTML = '';
    const cameras = this._getAllCameras();

    if (cameras.length === 0) {
      list.innerHTML = `<p class="text-muted" style="font-size:12px;padding:8px 0">
        No cameras yet. Add one to get started.</p>`;
      return;
    }

    for (const cam of cameras) {
      const card = document.createElement('div');
      card.className = 'list-card';
      card.innerHTML = `
        <div class="list-card-header">
          <div class="flex-row">
            <div class="cam-status-badge" data-badge="${cam.id}"></div>
            <span class="list-card-title">${cam.label || cam.id}</span>
          </div>
          <div class="card-actions">
            <button class="btn-edit" data-id="${cam.id}">Edit</button>
            <button class="btn-del" data-id="${cam.id}">Delete</button>
          </div>
        </div>
        <div class="list-card-sub monospace">${cam.url || '—'}</div>
        <div class="flex-row" style="gap:12px;margin-top:2px">
          <span class="text-muted" style="font-size:11px">ID: <span class="monospace">${cam.id}</span></span>
          <span class="text-muted" style="font-size:11px">${cam.transport || 'tcp'}</span>
          ${cam.type ? `<span class="text-muted" style="font-size:11px">${cam.type}</span>` : ''}
        </div>`;

      card.querySelector('.btn-edit').addEventListener('click', () => this.openCameraModal(cam));
      card.querySelector('.btn-del').addEventListener('click', () => this._deleteCamera(cam));
      list.appendChild(card);
    }

    // Update live badges from stream status
    this._updateStreamBadges();
  },

  async _updateStreamBadges() {
    try {
      const r = await fetch('/api/streams');
      const streams = await r.json();
      document.querySelectorAll('[data-badge]').forEach(el => {
        const id = el.dataset.badge;
        el.classList.toggle('live', !!streams[id]);
        el.classList.toggle('error', false);
      });
    } catch {}
  },

  // ─── Camera Modal ──────────────────────────────────────────────────────────

  openCameraModal(existingCam = null) {
    const isEdit = !!existingCam;
    const cam = existingCam || { id: '', label: '', url: '', transport: 'tcp', type: 'rtsp' };

    // Which layout pages exist (to assign camera to)
    const pageOpts = Object.keys(state.layouts).map(n =>
      `<option value="${n}">${state.layouts[n].label || n}</option>`).join('');

    const body = `
      <form id="cam-form" style="display:flex;flex-direction:column;gap:12px">
        <label>Camera ID (unique, no spaces)
          <input type="text" name="id" value="${cam.id}" placeholder="front-door" ${isEdit ? 'readonly' : ''} required>
        </label>
        <label>Display Label
          <input type="text" name="label" value="${cam.label || ''}" placeholder="Front Door">
        </label>
        <label>Stream URL
          <input type="url" name="url" value="${cam.url || ''}" 
            placeholder="rtsp://192.168.1.100:554/stream1" required
            pattern="(rtsp|rtsps|http|https|mjpeg)://.*">
          <span style="font-size:11px;color:var(--text-muted);margin-top:3px">
            rtsp://, http://, or mjpeg://
          </span>
        </label>
        <label>Transport (RTSP)
          <select name="transport">
            <option value="tcp" ${cam.transport==='tcp'?'selected':''}>TCP (recommended)</option>
            <option value="udp" ${cam.transport==='udp'?'selected':''}>UDP</option>
          </select>
        </label>
        <label>Stream Type
          <select name="type">
            <option value="rtsp"  ${cam.type==='rtsp' ?'selected':''}>RTSP → HLS (server transcode)</option>
            <option value="hls"   ${cam.type==='hls'  ?'selected':''}>HLS direct (.m3u8)</option>
            <option value="mjpeg" ${cam.type==='mjpeg'?'selected':''}>MJPEG (direct)</option>
          </select>
        </label>
        ${!isEdit ? `
        <label>Add to Layout Page
          <select name="page">${pageOpts || '<option value="">— Create a layout first —</option>'}</select>
        </label>` : ''}
        <div class="flex-row" style="margin-top:4px;gap:8px">
          <button type="submit" class="btn-primary">${isEdit ? 'Save Changes' : 'Add Camera'}</button>
          <button type="button" id="btn-test-cam" class="btn-sm" style="
            padding:8px 12px;border:1px solid var(--border);border-radius:4px;
            background:var(--surface3);color:var(--text-muted)">
            Test Connection
          </button>
        </div>
        <div id="cam-test-result" style="font-size:12px;font-family:var(--font-mono);display:none"></div>
      </form>`;

    Modal.open(isEdit ? `Edit Camera: ${cam.id}` : 'Add Camera', body);

    document.getElementById('btn-test-cam').addEventListener('click', async () => {
      const f = document.getElementById('cam-form');
      const url = f.url.value;
      const transport = f.transport.value;
      const res = document.getElementById('cam-test-result');
      res.style.display = 'block';
      res.textContent = '⏳ Testing connection…';
      res.style.color = 'var(--text-muted)';
      try {
        const r = await fetch('/api/test-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, transport })
        });
        const d = await r.json();
        if (d.ok) {
          res.textContent = '✓ Connection successful';
          res.style.color = 'var(--accent)';
        } else {
          res.textContent = '✗ ' + (d.error || 'Failed');
          res.style.color = 'var(--red)';
        }
      } catch {
        res.textContent = '✗ Server error';
        res.style.color = 'var(--red)';
      }
    });

    document.getElementById('cam-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const updated = {
        id:        fd.get('id').trim().replace(/\s+/g, '-'),
        label:     fd.get('label').trim(),
        url:       fd.get('url').trim(),
        transport: fd.get('transport'),
        type:      fd.get('type'),
      };

      if (isEdit) {
        // Update camera in all layouts that reference it
        await this._updateCameraInLayouts(cam.id, updated);
      } else {
        const page = fd.get('page');
        if (!page) { Toast.show('Select a layout page first', 'error'); return; }
        await this._addCameraToLayout(updated, page);
      }

      Modal.close();
      this._renderCameraList();
      Toast.show(isEdit ? 'Camera updated' : 'Camera added', 'success');
    });
  },

  async _addCameraToLayout(cam, pageName) {
    const layout = state.layouts[pageName];
    if (!layout) return;
    layout.cameras = layout.cameras || [];
    layout.cameras.push(cam);
    await fetch(`/api/layouts/${encodeURIComponent(pageName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout)
    });
    state.layouts[pageName] = layout;
  },

  async _updateCameraInLayouts(oldId, updated) {
    for (const [name, layout] of Object.entries(state.layouts)) {
      let changed = false;
      (layout.cameras || []).forEach((c, i) => {
        if (c.id === oldId) { layout.cameras[i] = { ...c, ...updated }; changed = true; }
      });
      if (changed) {
        await fetch(`/api/layouts/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(layout)
        });
        state.layouts[name] = layout;
      }
    }
  },

  async _deleteCamera(cam) {
    if (!confirm(`Delete camera "${cam.label || cam.id}"? It will be removed from all layouts.`)) return;
    for (const [name, layout] of Object.entries(state.layouts)) {
      const before = (layout.cameras || []).length;
      layout.cameras = (layout.cameras || []).filter(c => c.id !== cam.id);
      layout.windows = (layout.windows || []).filter(w => w.cameraId !== cam.id);
      if (layout.cameras.length !== before) {
        await fetch(`/api/layouts/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(layout)
        });
        state.layouts[name] = layout;
      }
    }
    this._renderCameraList();
    Toast.show('Camera deleted');
  },

  // ─── Layout List ───────────────────────────────────────────────────────────

  _renderLayoutList() {
    const list = document.getElementById('layout-list');
    list.innerHTML = '';
    const pages = Object.entries(state.layouts);

    if (pages.length === 0) {
      list.innerHTML = `<p class="text-muted" style="font-size:12px;padding:8px 0">
        No layout pages yet. Create one to arrange cameras.</p>`;
      return;
    }

    for (const [name, layout] of pages) {
      const winCount = (layout.windows || []).length;
      const camCount = (layout.cameras || []).length;
      const card = document.createElement('div');
      card.className = 'list-card';
      card.innerHTML = `
        <div class="list-card-header">
          <span class="list-card-title">${layout.label || name}</span>
          <div class="card-actions">
            <button class="btn-edit" data-name="${name}">Edit</button>
            <button class="btn-del" data-name="${name}">Delete</button>
          </div>
        </div>
        <div class="list-card-sub monospace" style="font-size:10px">
          ${winCount} window${winCount !== 1 ? 's' : ''} · ${camCount} camera${camCount !== 1 ? 's' : ''}
        </div>`;

      card.querySelector('.btn-edit').addEventListener('click', () => {
        LayoutEditor.open(name, layout);
      });
      card.querySelector('.btn-del').addEventListener('click', async () => {
        if (!confirm(`Delete layout "${layout.label || name}"?`)) return;
        await fetch(`/api/layouts/${encodeURIComponent(name)}`, { method: 'DELETE' });
        delete state.layouts[name];
        if (state.currentPage === name) state.currentPage = null;
        renderPageTabs();
        this._renderLayoutList();
        Toast.show('Layout deleted');
      });
      list.appendChild(card);
    }
  },

  promptNewLayout() {
    const body = `
      <form id="new-layout-form" style="display:flex;flex-direction:column;gap:12px">
        <label>Layout Name (used in URL/config)
          <input type="text" name="name" placeholder="main-view" required
            pattern="[a-zA-Z0-9_-]+" title="Letters, numbers, hyphens, underscores only">
        </label>
        <label>Display Label
          <input type="text" name="label" placeholder="Main View">
        </label>
        <label>Quick Setup — Grid Preset
          <select name="preset">
            <option value="blank">Blank (manual layout)</option>
            <option value="1x1">1×1 — Single camera</option>
            <option value="2x1">2×1 — Side by side</option>
            <option value="1x2">1×2 — Stacked</option>
            <option value="2x2">2×2 — Quad view</option>
            <option value="3x2">3×2 — Six cameras</option>
            <option value="4x3">4×3 — Twelve cameras</option>
            <option value="pip">PiP — 1 large + 3 small</option>
            <option value="featured">Featured — 1 large left + 2 right</option>
          </select>
        </label>
        <button type="submit" class="btn-primary">Create Layout</button>
      </form>`;

    Modal.open('New Layout Page', body);

    document.getElementById('new-layout-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name   = fd.get('name').trim();
      const label  = fd.get('label').trim() || name;
      const preset = fd.get('preset');

      if (state.layouts[name]) {
        Toast.show('A layout with that name already exists', 'error');
        return;
      }

      const layout = { label, cameras: [], windows: applyPreset(preset) };
      await fetch(`/api/layouts/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(layout)
      });
      state.layouts[name] = layout;
      renderPageTabs();
      switchPage(name);
      Modal.close();
      this.open('layouts');
      this._renderLayoutList();
      Toast.show(`Layout "${label}" created`, 'success');

      // Open editor immediately for non-blank presets so user can assign cameras
      setTimeout(() => LayoutEditor.open(name, layout), 200);
    });
  },

  // ─── Global Form ───────────────────────────────────────────────────────────

  _populateGlobalForm() {
    const f = document.getElementById('form-global');
    const c = state.config;
    if (!f || !c) return;
    if (f.title)       f.title.value       = c.title       || 'WebCameras';
    if (f.rotate)      f.rotate.checked    = !!c.rotate;
    if (f.rotatedelay) f.rotatedelay.value = c.rotatedelay || 30;
    if (f.startsleep)  f.startsleep.value  = c.startsleep  || 2;
    if (f.feedsleep)   f.feedsleep.value   = c.feedsleep   || 2;
    if (f.retry)       f.retry.value       = c.retry       || 3;
  },
};

// ─── Modal helper ─────────────────────────────────────────────────────────────
export const Modal = {
  open(title, bodyHtml) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById('modal-close').onclick = () => this.close();
    document.getElementById('modal-overlay').onclick = (e) => {
      if (e.target === document.getElementById('modal-overlay')) this.close();
    };
  },
  close() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('modal-body').innerHTML = '';
  }
};

// ─── Grid Presets ─────────────────────────────────────────────────────────────
function applyPreset(preset) {
  const windows = [];
  switch (preset) {
    case '1x1':
      windows.push({ id: 'w1', x:0,    y:0,    w:1,    h:1,    cameraId:'', label:'Camera 1' });
      break;
    case '2x1':
      windows.push({ id: 'w1', x:0,    y:0,    w:0.5,  h:1,    cameraId:'', label:'Camera 1' });
      windows.push({ id: 'w2', x:0.5,  y:0,    w:0.5,  h:1,    cameraId:'', label:'Camera 2' });
      break;
    case '1x2':
      windows.push({ id: 'w1', x:0,    y:0,    w:1,    h:0.5,  cameraId:'', label:'Camera 1' });
      windows.push({ id: 'w2', x:0,    y:0.5,  w:1,    h:0.5,  cameraId:'', label:'Camera 2' });
      break;
    case '2x2':
      windows.push({ id: 'w1', x:0,    y:0,    w:0.5,  h:0.5,  cameraId:'', label:'Camera 1' });
      windows.push({ id: 'w2', x:0.5,  y:0,    w:0.5,  h:0.5,  cameraId:'', label:'Camera 2' });
      windows.push({ id: 'w3', x:0,    y:0.5,  w:0.5,  h:0.5,  cameraId:'', label:'Camera 3' });
      windows.push({ id: 'w4', x:0.5,  y:0.5,  w:0.5,  h:0.5,  cameraId:'', label:'Camera 4' });
      break;
    case '3x2':
      for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
        windows.push({ id:`w${r*3+c+1}`, x:c/3, y:r/2, w:1/3, h:0.5, cameraId:'', label:`Camera ${r*3+c+1}` });
      }
      break;
    case '4x3':
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
        windows.push({ id:`w${r*4+c+1}`, x:c/4, y:r/3, w:0.25, h:1/3, cameraId:'', label:`Camera ${r*4+c+1}` });
      }
      break;
    case 'pip':
      windows.push({ id: 'w1', x:0,     y:0,    w:1,    h:1,     cameraId:'', label:'Main' });
      windows.push({ id: 'w2', x:0.68,  y:0.67, w:0.32, h:0.33,  cameraId:'', label:'PiP 1' });
      windows.push({ id: 'w3', x:0.34,  y:0.67, w:0.32, h:0.33,  cameraId:'', label:'PiP 2' });
      windows.push({ id: 'w4', x:0,     y:0.67, w:0.32, h:0.33,  cameraId:'', label:'PiP 3' });
      break;
    case 'featured':
      windows.push({ id: 'w1', x:0,     y:0,    w:0.667,h:1,     cameraId:'', label:'Featured' });
      windows.push({ id: 'w2', x:0.667, y:0,    w:0.333,h:0.333, cameraId:'', label:'Side 1' });
      windows.push({ id: 'w3', x:0.667, y:0.333,w:0.333,h:0.333, cameraId:'', label:'Side 2' });
      windows.push({ id: 'w4', x:0.667, y:0.667,w:0.333,h:0.333, cameraId:'', label:'Side 3' });
      break;
    default:
      break; // blank
  }
  return windows;
}
