const $ = (sel) => document.querySelector(sel);

function showMessage(msg, isError = false) {
  const el = $('#message');
  if (!el) return;
  el.textContent = msg;
  el.className = `message ${isError ? 'error' : 'success'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function validateEmail(v) { return typeof v === 'string' && v.includes('@') && v.indexOf(' ') === -1; }
function validatePassword(v) { return typeof v === 'string' && v.length >= 8; }

function isButtonLoading(button) {
  return !!button && button.dataset.loading === '1';
}

function setButtonLoading(button, isLoading, loadingText = 'Loading...') {
  if (!button) return;

  if (isLoading) {
    if (isButtonLoading(button)) return;
    button.dataset.loading = '1';
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText;
    button.classList.add('loading');
    button.disabled = true;
    return;
  }

  button.dataset.loading = '0';
  button.classList.remove('loading');
  if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
  }
}

function switchToForm(formId) {
  document.querySelectorAll('#login-card, #register-card, #forgot-password-card, #reset-password-card')
    .forEach(card => card.style.display = 'none');
  if (formId === 'auth') { switchToTab('login'); return; }
  const form = $(`#${formId}-card`);
  if (form) form.style.display = 'block';
}

function switchToTab(tab) {
  const loginTab    = $('#tab-login');
  const registerTab = $('#tab-register');
  const loginCard   = $('#login-card');
  const registerCard = $('#register-card');

  document.querySelectorAll('#forgot-password-card, #reset-password-card')
    .forEach(card => card.style.display = 'none');

  if (tab === 'login') {
    loginTab.classList.add('active');
    registerTab.classList.remove('active');
    loginTab.style.color = 'var(--text)';
    registerTab.style.color = 'var(--muted)';
    loginTab.style.borderBottomColor = 'var(--accent)';
    registerTab.style.borderBottomColor = 'transparent';
    loginCard.style.display = 'block';
    registerCard.style.display = 'none';
  } else {
    registerTab.classList.add('active');
    loginTab.classList.remove('active');
    registerTab.style.color = 'var(--text)';
    loginTab.style.color = 'var(--muted)';
    registerTab.style.borderBottomColor = 'var(--accent)';
    loginTab.style.borderBottomColor = 'transparent';
    registerCard.style.display = 'block';
    loginCard.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // ── Tab switching ──────────────────────────────────────────────────────────
  $('#tab-login')?.addEventListener('click', () => switchToTab('login'));
  $('#tab-register')?.addEventListener('click', () => switchToTab('register'));

  // ── Login ──────────────────────────────────────────────────────────────────
  const loginEmailEl = $('#login-email');
  const loginPassEl  = $('#login-password');
  const btnLogin     = $('#btn-login');

  const updateLoginButton = () => {
    if (btnLogin && !isButtonLoading(btnLogin)) btnLogin.disabled =
      !(validateEmail(loginEmailEl.value.trim()) && validatePassword(loginPassEl.value || ''));
  };
  loginEmailEl?.addEventListener('input', updateLoginButton);
  loginPassEl?.addEventListener('input', updateLoginButton);

  $('#toggle-login-password')?.addEventListener('click', (e) => {
    e.preventDefault();
    loginPassEl.type = loginPassEl.type === 'password' ? 'text' : 'password';
    e.target.textContent = loginPassEl.type === 'password' ? 'Show' : 'Hide';
  });

  loginPassEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnLogin.disabled) btnLogin.click(); });

  btnLogin?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (isButtonLoading(btnLogin)) return;
    let keepLoading = false;
    setButtonLoading(btnLogin, true, 'Logging in...');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email:    loginEmailEl.value.trim().toLowerCase(),
          password: loginPassEl.value || '',
        }),
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return showMessage(json.error || 'Authentication failed', true);
      showMessage('Logged in — redirecting…');
      keepLoading = true;
      setTimeout(() => { window.location.href = '/'; }, 600);
    } catch {
      showMessage('Request failed', true);
    } finally {
      if (!keepLoading) {
        setButtonLoading(btnLogin, false);
        updateLoginButton();
      }
    }
  });

  $('#btn-forgot-password')?.addEventListener('click', (e) => { e.preventDefault(); switchToForm('forgot-password'); });

  // ── Register ───────────────────────────────────────────────────────────────
  const registerEmailEl = $('#register-email');
  const registerPassEl  = $('#register-password');
  const btnRegister     = $('#btn-register');

  const updateRegisterButton = () => {
    if (btnRegister && !isButtonLoading(btnRegister)) btnRegister.disabled =
      !(validateEmail(registerEmailEl.value.trim()) && validatePassword(registerPassEl.value || ''));
  };
  registerEmailEl?.addEventListener('input', updateRegisterButton);
  registerPassEl?.addEventListener('input', updateRegisterButton);

  $('#toggle-register-password')?.addEventListener('click', (e) => {
    e.preventDefault();
    registerPassEl.type = registerPassEl.type === 'password' ? 'text' : 'password';
    e.target.textContent = registerPassEl.type === 'password' ? 'Show' : 'Hide';
  });

  registerPassEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnRegister.disabled) btnRegister.click(); });

  btnRegister?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (isButtonLoading(btnRegister)) return;
    let keepLoading = false;
    setButtonLoading(btnRegister, true, 'Creating account...');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email:    registerEmailEl.value.trim().toLowerCase(),
          password: registerPassEl.value || '',
        }),
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return showMessage(json.error || 'Registration failed', true);
      showMessage('Registered — redirecting…');
      keepLoading = true;
      setTimeout(() => { window.location.href = '/'; }, 600);
    } catch {
      showMessage('Request failed', true);
    } finally {
      if (!keepLoading) {
        setButtonLoading(btnRegister, false);
        updateRegisterButton();
      }
    }
  });

  // ── Forgot password ────────────────────────────────────────────────────────
  const forgotEmailEl = $('#forgot-email');
  const btnSendReset  = $('#btn-send-reset');

  const updateForgotButton = () => {
    if (btnSendReset && !isButtonLoading(btnSendReset)) {
      btnSendReset.disabled = !validateEmail(forgotEmailEl.value.trim());
    }
  };
  forgotEmailEl?.addEventListener('input', updateForgotButton);
  forgotEmailEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnSendReset.disabled) btnSendReset.click(); });

  btnSendReset?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (isButtonLoading(btnSendReset)) return;
    setButtonLoading(btnSendReset, true, 'Sending...');
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmailEl.value.trim().toLowerCase() }),
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return showMessage(json.error || 'Failed to send reset link', true);
      showMessage('Reset link sent — check your inbox!');
      setTimeout(() => { switchToForm('auth'); forgotEmailEl.value = ''; updateForgotButton(); }, 2000);
    } catch {
      showMessage('Request failed', true);
    } finally {
      setButtonLoading(btnSendReset, false);
      updateForgotButton();
    }
  });

  $('#btn-back-to-login')?.addEventListener('click', (e) => { e.preventDefault(); switchToForm('auth'); });

  // ── Reset password ─────────────────────────────────────────────────────────
  const resetPassEl    = $('#reset-password');
  const resetConfirmEl = $('#reset-confirm');
  const btnReset       = $('#btn-reset-password');

  const updateResetButton = () => {
    const p = resetPassEl?.value || '';
    if (btnReset && !isButtonLoading(btnReset)) {
      btnReset.disabled = !(validatePassword(p) && p === (resetConfirmEl?.value || ''));
    }
  };
  resetPassEl?.addEventListener('input', updateResetButton);
  resetConfirmEl?.addEventListener('input', updateResetButton);
  resetConfirmEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btnReset.disabled) btnReset.click(); });

  $('#toggle-reset-password')?.addEventListener('click', (e) => {
    e.preventDefault();
    const type = resetPassEl.type === 'password' ? 'text' : 'password';
    resetPassEl.type = resetConfirmEl.type = type;
    e.target.textContent = type === 'password' ? 'Show' : 'Hide';
  });

  btnReset?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (isButtonLoading(btnReset)) return;
    setButtonLoading(btnReset, true, 'Resetting...');
    const token = new URLSearchParams(window.location.search).get('reset_token');
    if (!token) {
      showMessage('Invalid reset link', true);
      setButtonLoading(btnReset, false);
      updateResetButton();
      return;
    }
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: resetPassEl.value }),
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return showMessage(json.error || 'Failed to reset password', true);
      showMessage('Password reset — redirecting to login…');
      setTimeout(() => { window.location.href = '/auth.html'; }, 2000);
    } catch {
      showMessage('Request failed', true);
    } finally {
      setButtonLoading(btnReset, false);
      updateResetButton();
    }
  });

  $('#btn-back-to-login-2')?.addEventListener('click', (e) => { e.preventDefault(); switchToForm('auth'); });

  // ── Init ───────────────────────────────────────────────────────────────────
  const params = new URLSearchParams(window.location.search);
  if (params.has('reset_token')) {
    switchToForm('reset-password');
  } else {
    switchToTab('login');
  }

  updateLoginButton();
  updateRegisterButton();
  updateForgotButton();
});
