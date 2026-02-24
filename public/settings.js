const $ = (sel) => document.querySelector(sel);

async function apiRequest(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  };
  let res  = await fetch(path, opts);
  let json = await res.json().catch(() => ({}));
  if (res.ok) return json;

  if (res.status === 401) {
    const refreshed = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    });
    if (refreshed.ok) {
      res  = await fetch(path, opts);
      json = await res.json().catch(() => ({}));
      if (res.ok) return json;
    } else {
      window.location.href = '/auth';
      throw new Error('Session expired');
    }
  }

  throw json;
}

function showMessage(msg, isError = false) {
  const el = $('#message');
  el.textContent = msg;
  el.className = `message ${isError ? 'error' : 'success'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}


function handleLogout() {
  fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  window.location.href = '/auth';
}

async function init() {
  // Wire up buttons
  $('#btn-logout').addEventListener('click', handleLogout);
}

init();