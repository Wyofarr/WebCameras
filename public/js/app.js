/**
 * WebCameras — Browser Application
 * Manages layouts, pages, camera streams (HLS via hls.js), and UI state
 */

import { LayoutManager }   from './layout.js';
import { StreamManager }   from './stream.js';
import { SettingsPanel }   from './settings.js';
import { Toast }           from './toast.js';

// ─── Global State ────────────────────────────────────────────────────────────
export const state = {
  config:       {},
  layouts:      {},     // { name: layoutDef }
  currentPage:  null,   // layout name
  rotateTimer:  null,
  connected:    false,
};

// ─── Socket.IO ───────────────────────────────────────────────────────────────
const socket = window.io ? window.io() : null;

if (socket) {
  socket.on('connect', () => {
    state.connected = true;
    document.getElementById('status-dot').classList.remove('disconnected');
    Toast.show('Server connected', 'success');
    init();
  });
  socket.on('disconnect', () => {
    state.connected = false;
    document.getElementById('status-dot').classList.add('disconnected');
    Toast.show('Server disconnected', 'error');
  });
  socket.on('layouts:updated', () => fetchLayouts());
  socket.on('config:updated',  (cfg) => { state.config = cfg; applyConfig(); });
  socket.on('stream:ready',    ({ id }) => StreamManager.onReady(id));
  socket.on('stream:stopped',  ({ id }) => StreamManager.onStopped(id));
} else {
  // Dev/offline fallback — use demo data
  init();
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function init() {
  await fetchConfig();
  await fetchLayouts();
  applyConfig();
  renderPageTabs();
  if (state.currentPage) {
    LayoutManager.render(state.currentPage);
  }
  SettingsPanel.init();
  bindTopbarEvents();
  startRotateIfNeeded();
}

async function fetchConfig() {
  try {
    const r = await fetch('/api/config');
    state.config = await r.json();
  } catch { state.config = {}; }
}

async function fetchLayouts() {
  try {
    const r = await fetch('/api/layouts');
    state.layouts = await r.json();
    // Set current page if needed
    const pages = Object.keys(state.layouts);
    if (!state.currentPage || !state.layouts[state.currentPage]) {
      state.currentPage = pages[0] || null;
    }
    renderPageTabs();
    if (state.currentPage) {
      LayoutManager.render(state.currentPage);
    } else {
      showEmpty(true);
    }
    SettingsPanel.refresh();
  } catch (e) {
    console.error('Failed to fetch layouts', e);
  }
}

function applyConfig() {
  if (state.config.title) document.title = state.config.title;
  const el = document.getElementById('app-name');
  if (el) el.textContent = state.config.title || 'WebCameras';
  startRotateIfNeeded();
}

// ─── Page Tabs ───────────────────────────────────────────────────────────────
export function renderPageTabs() {
  const container = document.getElementById('page-tabs');
  container.innerHTML = '';
  const pages = Object.keys(state.layouts);

  if (pages.length === 0) {
    showEmpty(true);
    return;
  }
  showEmpty(false);

  for (const name of pages) {
    const layout = state.layouts[name];
    const tab = document.createElement('button');
    tab.className = 'page-tab' + (name === state.currentPage ? ' active' : '');
    tab.innerHTML = `
      <span class="tab-name">${layout.label || name}</span>
      <span class="tab-del" data-name="${name}" title="Delete page">✕</span>`;
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-del')) return;
      switchPage(name);
    });
    tab.querySelector('.tab-del').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDeletePage(name);
    });
    container.appendChild(tab);
  }
}

export function switchPage(name) {
  state.currentPage = name;
  renderPageTabs();
  LayoutManager.render(name);
  resetRotate();
}

function confirmDeletePage(name) {
  if (!confirm(`Delete layout page "${name}"? This cannot be undone.`)) return;
  fetch(`/api/layouts/${encodeURIComponent(name)}`, { method: 'DELETE' })
    .then(() => { Toast.show(`Deleted: ${name}`); fetchLayouts(); });
}

// ─── Empty state ─────────────────────────────────────────────────────────────
function showEmpty(show) {
  document.getElementById('empty-state').classList.toggle('hidden', !show);
  document.getElementById('camera-grid').classList.toggle('hidden', show);
}

// ─── Auto-rotate ─────────────────────────────────────────────────────────────
function startRotateIfNeeded() {
  clearInterval(state.rotateTimer);
  if (!state.config.rotate) return;
  const delay = (state.config.rotatedelay || 30) * 1000;
  state.rotateTimer = setInterval(() => {
    const pages = Object.keys(state.layouts);
    if (pages.length < 2) return;
    const idx = pages.indexOf(state.currentPage);
    switchPage(pages[(idx + 1) % pages.length]);
  }, delay);
}

function resetRotate() {
  startRotateIfNeeded();
}

// ─── Topbar events ───────────────────────────────────────────────────────────
function bindTopbarEvents() {
  document.getElementById('btn-settings').addEventListener('click', () => {
    SettingsPanel.toggle();
  });
  document.getElementById('btn-empty-settings').addEventListener('click', () => {
    SettingsPanel.open();
  });
  document.getElementById('btn-add-page').addEventListener('click', () => {
    SettingsPanel.open('layouts');
    SettingsPanel.promptNewLayout();
  });
  document.getElementById('btn-fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  });

  // Camera fullscreen close
  document.getElementById('cam-fs-close').addEventListener('click', () => {
    StreamManager.closeFullscreen();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const fs = document.getElementById('cam-fullscreen');
      if (!fs.classList.contains('hidden')) StreamManager.closeFullscreen();
    }
    if (e.key === 'ArrowRight') {
      const pages = Object.keys(state.layouts);
      if (pages.length < 2) return;
      const idx = pages.indexOf(state.currentPage);
      switchPage(pages[(idx + 1) % pages.length]);
    }
    if (e.key === 'ArrowLeft') {
      const pages = Object.keys(state.layouts);
      if (pages.length < 2) return;
      const idx = pages.indexOf(state.currentPage);
      switchPage(pages[(idx - 1 + pages.length) % pages.length]);
    }
  });
}
