/**
 * WebCameras — Browser Application
 */

import { LayoutManager } from './layout.js';
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

    // Determine which page to show:
    // 1. Keep current page if it still exists
    // 2. Use configured defaultPage if set and valid
    // 3. Fall back to first page
    if (state.currentPage && state.layouts[state.currentPage]) {
      // keep current
    } else {
      const def = state.config.defaultPage;
      if (def && state.layouts[def]) {
        state.currentPage = def;
      } else {
        state.currentPage = pages[0] || null;
      }
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
  updateDefaultPageIndicator();
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
    tab.title = isDefault ? 'Default page (loads first)' : 'Click to view · right-click for options';
    tab.innerHTML = `
      <span class="tab-name">${layout.label || name}</span>
      ${isDefault ? '<span class="tab-default-dot" title="Default page">●</span>' : ''}
      <span class="tab-del" data-name="${name}" title="Delete page">✕</span>`;

    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-del')) return;
      switchPage(name);
    });

    // Right-click / long-press → set as default
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

function updateDefaultPageIndicator() {
  document.querySelectorAll('.page-tab').forEach(tab => {
    const nameEl = tab.querySelector('.tab-name');
    if (!nameEl) return;
    // rebuild tabs to update indicators
  });
}

export function switchPage(name) {
  state.currentPage = name;
  renderPageTabs();
  LayoutManager.render(name);
  resetRotate();
}

async function setDefaultPage(name) {
  const label = state.layouts[name]?.label || name;
  if (!confirm(`Set "${label}" as the default page that loads when opening the app?`)) return;
  const cfg = { ...state.config, defaultPage: name };
  await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg)
  });
  state.config = cfg;
  renderPageTabs();
  Toast.show(`"${label}" set as default page`, 'success');
}

function confirmDeletePage(name) {
  if (!confirm(`Delete layout page "${name}"? This cannot be undone.`)) return;
  fetch(`/api/layouts/${encodeURIComponent(name)}`, { method: 'DELETE' })
    .then(() => {
      Toast.show(`Deleted: ${name}`);
      // If this was the default, clear it
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
    const idx = pages.indexOf(state.currentPage);
    switchPage(pages[(idx + 1) % pages.length]);
  }, delay);
}

function resetRotate() { startRotateIfNeeded(); }

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
      switchPage(pages[(pages.indexOf(state.currentPage) + 1) % pages.length]);
    }
    if (e.key === 'ArrowLeft') {
      const pages = Object.keys(state.layouts);
      if (pages.length < 2) return;
      switchPage(pages[(pages.indexOf(state.currentPage) - 1 + pages.length) % pages.length]);
    }
  });
}

// ─── Swipe gestures ─────────────────────────────────────────────────────────
function initSwipeGestures() {
  const area = document.getElementById('view-area');
  if (!area) return;

  let startX = 0, startY = 0, startTime = 0;

  area.addEventListener('touchstart', (e) => {
    startX    = e.touches[0].clientX;
    startY    = e.touches[0].clientY;
    startTime = Date.now();
  }, { passive: true });

  area.addEventListener('touchend', (e) => {
    const dx   = e.changedTouches[0].clientX - startX;
    const dy   = e.changedTouches[0].clientY - startY;
    const dt   = Date.now() - startTime;
    const pages = Object.keys(state.layouts);

    // Must be fast (<400ms), horizontal (|dx|>|dy|*1.5), and long enough (>60px)
    if (dt > 400 || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (pages.length < 2) return;

    const idx = pages.indexOf(state.currentPage);
    if (dx < 0) {
      // Swipe left → next page
      switchPage(pages[(idx + 1) % pages.length]);
    } else {
      // Swipe right → prev page
      switchPage(pages[(idx - 1 + pages.length) % pages.length]);
    }
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
