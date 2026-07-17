/**
 * WebCameras — Browser Application
 * Version: 2026.07.04
 */

import { LayoutManager }  from './layout.js';
import { StreamManager }  from './stream.js';
import { SettingsPanel }  from './settings.js';
import { Toast }          from './toast.js';

export const state = {
  config:      {},
  layouts:     {},
  currentPage: null,
  rotateTimer: null,
  connected:   false,
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
  init();
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────
async function init() {
  await fetchConfig();
  await fetchLayouts();
  applyConfig();
  renderPageTabs();
  if (state.currentPage) LayoutManager.render(state.currentPage);
  SettingsPanel.init();
  bindTopbarEvents();
  initSwipeGestures();
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
    const pages = Object.keys(state.layouts);

    if (state.currentPage && state.layouts[state.currentPage]) {
      // keep current
    } else {
      const def = state.config.defaultPage;
      state.currentPage = (def && state.layouts[def]) ? def : (pages[0] || null);
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

  if (pages.length === 0) { showEmpty(true); return; }
  showEmpty(false);

  for (const name of pages) {
    const layout = state.layouts[name];
    const isDefault = name === state.config.defaultPage;
    const tab = document.createElement('button');
    tab.className = 'page-tab' + (name === state.currentPage ? ' active' : '');
    tab.title = 'Click to view · right-click to set as default';
    tab.innerHTML = `
      <span class="tab-name">${layout.label || name}</span>
      ${isDefault ? '<span class="tab-default-dot">●</span>' : ''}
      <span class="tab-del" data-name="${name}" title="Delete page">✕</span>`;

    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-del')) return;
      switchPage(name);
    });
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      setDefaultPage(name);
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

async function setDefaultPage(name) {
  const label = state.layouts[name]?.label || name;
  if (!confirm(`Set "${label}" as the default page?`)) return;
  const cfg = { ...state.config, defaultPage: name };
  await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg)
  });
  state.config = cfg;
  renderPageTabs();
  Toast.show(`"${label}" set as default`, 'success');
}

function confirmDeletePage(name) {
  if (!confirm(`Delete layout "${name}"? Cannot be undone.`)) return;
  fetch(`/api/layouts/${encodeURIComponent(name)}`, { method: 'DELETE' })
    .then(() => {
      Toast.show(`Deleted: ${name}`);
      if (state.config.defaultPage === name) {
        state.config.defaultPage = '';
        fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.config)
        }).catch(() => {});
      }
      fetchLayouts();
    });
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
    switchPage(pages[(pages.indexOf(state.currentPage) + 1) % pages.length]);
  }, delay);
}
function resetRotate() { startRotateIfNeeded(); }

// ─── Info Popup (brand click → version + camera status) ──────────────────────
export async function showInfoPopup() {
  const popup = document.getElementById('info-popup');
  popup.classList.remove('hidden');

  // Version
  try {
    const r = await fetch('/api/version');
    const v = await r.json();
    document.getElementById('info-version').textContent = v.version || '—';
    if (v.latest && v.latest !== v.version) {
      document.getElementById('info-update-row').style.display = 'flex';
      document.getElementById('info-latest').textContent = v.latest;
    } else {
      document.getElementById('info-update-row').style.display = 'none';
    }
  } catch {
    document.getElementById('info-version').textContent = 'unknown';
  }

  // Camera status
  const camsEl = document.getElementById('info-cams');
  camsEl.innerHTML = '';
  try {
    const [streamsR] = await Promise.all([fetch('/api/streams')]);
    const streams = await streamsR.json();

    // Collect all cameras across layouts
    const allCams = [];
    const seen = new Set();
    for (const layout of Object.values(state.layouts)) {
      for (const cam of layout.cameras || []) {
        if (!seen.has(cam.id)) { seen.add(cam.id); allCams.push(cam); }
      }
    }

    if (allCams.length === 0) {
      camsEl.innerHTML = '<div style="font-size:12px;color:var(--text-dim)">No cameras configured</div>';
    } else {
      for (const cam of allCams) {
        const live = !!streams[cam.id];
        const row = document.createElement('div');
        row.className = 'info-cam-row';
        row.innerHTML = `
          <div class="info-cam-dot ${live ? 'live' : ''}"></div>
          <span class="info-cam-name">${cam.label || cam.id}</span>
          <span class="info-cam-status">${live ? 'LIVE' : 'idle'}</span>`;
        camsEl.appendChild(row);
      }
    }
  } catch {
    camsEl.innerHTML = '<div style="font-size:12px;color:var(--text-dim)">Status unavailable</div>';
  }
}

function closeInfoPopup() {
  document.getElementById('info-popup').classList.add('hidden');
}

// Expose for mobile nav and inline onclick
window.showInfoPopup = showInfoPopup;

// ─── New Layout — accessible directly from main page ─────────────────────────
export function triggerNewLayout() {
  SettingsPanel.promptNewLayout();
}
window.triggerNewLayout = triggerNewLayout;

// ─── Topbar events ───────────────────────────────────────────────────────────
function bindTopbarEvents() {
  // Brand click → info popup
  document.getElementById('topbar-brand').addEventListener('click', showInfoPopup);

  // Info popup close
  document.getElementById('info-popup-close').addEventListener('click', closeInfoPopup);
  document.getElementById('info-popup').addEventListener('click', (e) => {
    if (e.target === document.getElementById('info-popup')) closeInfoPopup();
  });

  // + New layout button in topbar
  document.getElementById('btn-add-page').addEventListener('click', () => {
    SettingsPanel.promptNewLayout();
  });

  // Empty state button
  document.getElementById('btn-empty-add').addEventListener('click', () => {
    SettingsPanel.promptNewLayout();
  });

  // Fullscreen — must be called directly from user gesture
  document.getElementById('btn-fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen()
        .catch(err => console.warn('Fullscreen error:', err));
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  // Camera fullscreen close
  document.getElementById('cam-fs-close').addEventListener('click', () => {
    StreamManager.closeFullscreen();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const fs = document.getElementById('cam-fullscreen');
      if (!fs.classList.contains('hidden')) { StreamManager.closeFullscreen(); return; }
      const info = document.getElementById('info-popup');
      if (!info.classList.contains('hidden')) { closeInfoPopup(); return; }
    }
    if (e.key === 'ArrowRight') {
      const pages = Object.keys(state.layouts);
      if (pages.length < 2) return;
      switchPage(pages[(pages.indexOf(state.currentPage) + 1) % pages.length]);
    }
    if (e.key === 'ArrowLeft') {
      const pages = Object.keys(state.layouts);
      if (pages.length < 2) return;
      switchPage(pages[(pages.indexOf(state.currentPage) - 1 + pages.length) % pages.length]);
    }
  });
}

// ─── Swipe gestures ──────────────────────────────────────────────────────────
function initSwipeGestures() {
  const area = document.getElementById('view-area');
  if (!area) return;
  let startX = 0, startY = 0, startTime = 0;

  area.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startTime = Date.now();
  }, { passive: true });

  area.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    const dt = Date.now() - startTime;
    const pages = Object.keys(state.layouts);
    if (dt > 400 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (pages.length < 2) return;
    const idx = pages.indexOf(state.currentPage);
    switchPage(dx < 0
      ? pages[(idx + 1) % pages.length]
      : pages[(idx - 1 + pages.length) % pages.length]);
  }, { passive: true });
}

// ─── Mobile Navigation ───────────────────────────────────────────────────────
export function mobileNav(mode, btn) {
  document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (mode === 'settings') {
    SettingsPanel.open();
  } else {
    SettingsPanel.close();
    document.getElementById('mnav-view')?.classList.add('active');
  }
}

export function mobilePrevPage() {
  const pages = Object.keys(state.layouts);
  if (pages.length < 2) return;
  switchPage(pages[(pages.indexOf(state.currentPage) - 1 + pages.length) % pages.length]);
}

export function mobileNextPage() {
  const pages = Object.keys(state.layouts);
  if (pages.length < 2) return;
  switchPage(pages[(pages.indexOf(state.currentPage) + 1) % pages.length]);
}

window.mobileNav      = mobileNav;
window.mobilePrevPage = mobilePrevPage;
window.mobileNextPage = mobileNextPage;
