/**
 * Toast notifications — lightweight, auto-dismiss
 */

// Create container once
let container;
function getContainer() {
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

export const Toast = {
  show(message, type = '', duration = 3000) {
    const c = getContainer();
    const el = document.createElement('div');
    el.className = `toast${type ? ' ' + type : ''}`;
    el.textContent = message;
    c.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 300);
    }, duration);
  }
};
