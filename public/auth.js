const $ = (sel) => document.querySelector(sel);
const analytics = window.analytics || null;

function track(event, props) {
  try { analytics?.track?.(event, props || {}); } catch (_) { /* no-op */ }
}

function identifyUser(distinctId, props) {
  try { analytics?.identify?.(distinctId, props || {}); } catch (_) { /* no-op */ }
}

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
function getPasswordValidationIssues(v) {
  const value = String(v || '');
  const issues = [];
  if (value.length < 8) issues.push('At least 8 characters');
  if (!/[A-Z]/.test(value)) issues.push('At least one uppercase letter');
  if (!/[a-z]/.test(value)) issues.push('At least one lowercase letter');
  if (!/[0-9]/.test(value)) issues.push('At least one number');
  return issues;
}

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

function setHelpText(el, message, isError = false) {
  if (!el) return;
  el.textContent = message;
  el.className = isError ? 'field-error' : 'field-ok';
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

function parseHashParams() {
  const raw = (window.location.hash || '').replace(/^#/, '');
  return new URLSearchParams(raw);
}

function getRecoveryContext() {
  const search = new URLSearchParams(window.location.search);
  const hash = parseHashParams();
  const type = search.get('type') || hash.get('type') || '';
  const legacyResetToken = search.get('reset_token');
  const accessToken = hash.get('access_token') || search.get('access_token');
  const isCallbackPath = /^\/auth\/callback\/?$/.test(window.location.pathname || '');
  const hasRecoveryIntent = Boolean(
    legacyResetToken ||
    type === 'recovery' ||
    (accessToken && type === 'recovery') ||
    ((search.get('token') || hash.get('token')) && type === 'recovery')
  );
  const hasSignupConfirmIntent = Boolean(
    type === 'signup' ||
    (accessToken && type === 'signup') ||
    // Some providers/openers strip or omit `type` on callback links.
    // If we are on the dedicated callback path with an access token and
    // no recovery intent, treat it as signup/confirm success.
    (isCallbackPath && accessToken && !hasRecoveryIntent)
  );
  return { hasRecoveryIntent, hasSignupConfirmIntent, type, legacyResetToken, accessToken };
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
      identifyUser(json?.user?.id || loginEmailEl.value.trim().toLowerCase(), {
        email: loginEmailEl.value.trim().toLowerCase(),
      });
      track('auth_login_completed', { method: 'password' });
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
  const registerPasswordHelpEl = $('#register-password-help');

  const updateRegisterButton = () => {
    const passIssues = getPasswordValidationIssues(registerPassEl.value || '');
    if (registerPassEl?.value) {
      if (passIssues.length) {
        setHelpText(registerPasswordHelpEl, `Password requirements: ${passIssues.join(', ')}`, true);
      } else {
        setHelpText(registerPasswordHelpEl, 'Password looks good.', false);
      }
    } else {
      setHelpText(registerPasswordHelpEl, 'At least 8 characters, include letters and numbers.', false);
    }

    if (btnRegister && !isButtonLoading(btnRegister)) btnRegister.disabled =
      !(validateEmail(registerEmailEl.value.trim()) && passIssues.length === 0);
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
    track('auth_signup_started', { method: 'password' });
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
      if (!res.ok) {
        const details = Array.isArray(json?.details) ? json.details : [];
        const passwordError = details.find((d) => d?.field === 'password')?.message;
        if (passwordError) setHelpText(registerPasswordHelpEl, passwordError, true);
        return showMessage(json.error || 'Registration failed', true);
      }
      if (json.requires_email_confirmation) {
        track('auth_signup_completed', { requires_email_confirmation: true });
        showMessage(json.message || 'Check your email to confirm your account.');
        registerPassEl.value = '';
        switchToTab('login');
        return;
      }
      identifyUser(json?.user?.id || registerEmailEl.value.trim().toLowerCase(), {
        email: registerEmailEl.value.trim().toLowerCase(),
      });
      track('auth_signup_completed', { requires_email_confirmation: false });
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
      track('auth_password_reset_requested', {});
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
  const resetPasswordHelpEl = $('#reset-password-help');
  const resetConfirmHelpEl = $('#reset-confirm-help');

  const updateResetButton = () => {
    const p = resetPassEl?.value || '';
    const passIssues = getPasswordValidationIssues(p);
    if (p) {
      if (passIssues.length) {
        setHelpText(resetPasswordHelpEl, `Password requirements: ${passIssues.join(', ')}`, true);
      } else {
        setHelpText(resetPasswordHelpEl, 'Password looks good.', false);
      }
    } else {
      setHelpText(resetPasswordHelpEl, 'At least 8 characters, include letters and numbers.', false);
    }

    const matches = p === (resetConfirmEl?.value || '');
    if (resetConfirmEl?.value && !matches) {
      setHelpText(resetConfirmHelpEl, 'Passwords do not match.', true);
    } else {
      setHelpText(resetConfirmHelpEl, '', false);
    }

    if (btnReset && !isButtonLoading(btnReset)) {
      btnReset.disabled = !(passIssues.length === 0 && matches);
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
    const ctx = getRecoveryContext();
    try {
      let endpoint = '/api/auth/reset-password';
      let body = { token: ctx.legacyResetToken, newPassword: resetPassEl.value };

      // Supabase recovery links usually provide access_token in URL hash.
      if (!ctx.legacyResetToken && ctx.accessToken) {
        endpoint = '/api/auth/reset-password-supabase';
        body = { accessToken: ctx.accessToken, newPassword: resetPassEl.value };
      }

      if (!body.token && !body.accessToken) {
        showMessage('Invalid reset link', true);
        return;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return showMessage(json.error || 'Failed to reset password', true);
      track('auth_password_reset_completed', { flow: body.accessToken ? 'supabase' : 'legacy' });
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
  const recovery = getRecoveryContext();
  if (recovery.hasRecoveryIntent) {
    track('auth_recovery_link_opened', { type: recovery.type || 'recovery' });
    switchToForm('reset-password');
  } else if (recovery.hasSignupConfirmIntent) {
    track('auth_signup_email_confirmed', { type: recovery.type || 'signup' });
    switchToTab('login');
    showMessage('Email verified. You can now log in.');
  } else {
    switchToTab('login');
  }

  updateLoginButton();
  updateRegisterButton();
  updateForgotButton();
});
