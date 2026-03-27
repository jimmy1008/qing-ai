// Shared auth and utility helpers for all dashboard pages.
// Load this file BEFORE any page-specific scripts.

function getToken() {
  return localStorage.getItem('teamToken') || '';
}

function authFetch(url, opts = {}) {
  const token = getToken();
  return fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), 'x-team-token': token },
  });
}

// ── Toast notification ─────────────────────────────────────────────────────
// Types: 'success' | 'error' | 'info'
function showToast(message, type = 'success') {
  let container = document.getElementById('_toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = '_toastContainer';
    container.style.cssText = [
      'position:fixed', 'bottom:24px', 'right:24px',
      'display:flex', 'flex-direction:column', 'gap:8px',
      'z-index:9999', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(container);
  }

  const COLOR = { success: '#4ade80', error: '#f87171', info: '#60a5fa' };
  const toast = document.createElement('div');
  toast.style.cssText = [
    'background:#1a2030',
    `border:1px solid ${COLOR[type] || COLOR.info}`,
    'border-radius:8px',
    'padding:10px 16px',
    'font-size:13px',
    `color:${COLOR[type] || COLOR.info}`,
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'opacity:1',
    'transition:opacity 0.3s ease',
    'pointer-events:none',
    'max-width:320px',
    'white-space:pre-line',
  ].join(';');
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  setTimeout(() => { toast.remove(); }, 2900);
}
