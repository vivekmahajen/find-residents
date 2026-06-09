'use strict';

const msgEl = document.getElementById('auth-msg');
const tabs = document.querySelectorAll('.auth-tab');
const views = {
  login: document.getElementById('login-form'),
  signup: document.getElementById('signup-form'),
  forgot: document.getElementById('forgot-form'),
  reset: document.getElementById('reset-form'),
};

function setMsg(text, kind) {
  msgEl.textContent = text || '';
  msgEl.className = 'auth-msg' + (kind ? ` ${kind}` : '');
}

function showView(name) {
  for (const [key, form] of Object.entries(views)) form.hidden = key !== name;
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  // Tabs only represent login/signup.
  if (name === 'forgot' || name === 'reset') {
    tabs.forEach((t) => t.classList.remove('active'));
  }
  setMsg('');
}

// Wire tab + link buttons that carry a data-view.
document.querySelectorAll('[data-view]').forEach((el) => {
  el.addEventListener('click', () => showView(el.dataset.view));
});

async function postJson(url, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, data };
}

// --- Login ---
views.login.addEventListener('submit', async (e) => {
  e.preventDefault();
  setMsg('Signing in…');
  const { ok, data } = await postJson('/api/auth/login', {
    identifier: document.getElementById('login-id').value.trim(),
    password: document.getElementById('login-pw').value,
  });
  if (ok) {
    window.location.href = '/app';
  } else {
    setMsg(data.error || 'Sign in failed.', 'error');
  }
});

// --- Sign up ---
views.signup.addEventListener('submit', async (e) => {
  e.preventDefault();
  setMsg('Creating your account…');
  const { ok, data } = await postJson('/api/auth/signup', {
    username: document.getElementById('su-user').value.trim(),
    email: document.getElementById('su-email').value.trim(),
    password: document.getElementById('su-pw').value,
  });
  if (ok) {
    window.location.href = '/app';
  } else {
    setMsg(data.error || 'Could not create account.', 'error');
  }
});

// --- Forgot password ---
views.forgot.addEventListener('submit', async (e) => {
  e.preventDefault();
  setMsg('Sending…');
  const { data } = await postJson('/api/auth/forgot', {
    email: document.getElementById('fp-email').value.trim(),
  });
  // Always show the same confirmation (no account enumeration).
  setMsg('If that email is registered, a reset link is on its way.', 'success');
  // Dev convenience: if the server returned a link (no email provider configured), show it.
  if (data && data.devResetLink) {
    const a = document.createElement('a');
    a.href = data.devResetLink;
    a.textContent = 'Open reset link (dev)';
    a.className = 'dev-link';
    msgEl.appendChild(document.createElement('br'));
    msgEl.appendChild(a);
  }
});

// --- Reset password ---
let resetToken = null;
views.reset.addEventListener('submit', async (e) => {
  e.preventDefault();
  setMsg('Updating password…');
  const { ok, data } = await postJson('/api/auth/reset', {
    token: resetToken,
    password: document.getElementById('rp-pw').value,
  });
  if (ok) {
    setMsg('Password updated. You can log in now.', 'success');
    showView('login');
  } else {
    setMsg(data.error || 'Could not reset password.', 'error');
  }
});

// If the URL carries a reset token, jump straight to the reset view.
const params = new URLSearchParams(window.location.search);
if (params.get('token')) {
  resetToken = params.get('token');
  showView('reset');
}
