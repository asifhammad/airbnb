const $ = (sel) => document.querySelector(sel);
const analytics = window.analytics || null;

function track(event, props) {
  try { analytics?.track?.(event, props || {}); } catch (_) { /* no-op */ }
}

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

// Small helper to toggle a button's loading state (adds spinner + disables)
function setBtnLoading(btn, loading, tempText) {
  if (!btn) return;
  try {
    if (loading) {
      if (typeof tempText === 'string') {
        btn.dataset._orig = btn.innerHTML;
        btn.textContent = tempText;
      }
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
      if (btn.dataset._orig) { btn.innerHTML = btn.dataset._orig; delete btn.dataset._orig; }
    }
  } catch (e) { /* best-effort */ }
}

function handleLogout() {
  fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  window.location.href = '/auth';
}

// ── Billing / subscription ───────────────────────────────────────────────────

let _currentSubscription = null; // cached so plan cards know what's active
let _selectedPlanKey = null;

const PLAN_DISPLAY = {
  basic_monthly:   { name: 'Basic',            price: '$4.99',  billing: '$4.99 billed every month',  desc: '1 search, 1 email a day with newly available listings' },
  premium_monthly: { name: 'Premium',           price: '$14.99', billing: '$14.99 billed every month', desc: '10 searches, email as soon as newly available listings detected' },
  premium_yearly:  { name: 'Premium — yearly',  price: '$89.99', billing: '$89.99 billed every year',  desc: '10 searches, email as soon as newly available listings detected', badge: '50% off' },
};

async function loadSubscription() {
  try {
    const res = await apiRequest('GET', '/api/billing/subscription');
    _currentSubscription = res;
    renderPlanSummary(res);
    return res;
  } catch (err) {
    console.error('loadSubscription error', err);
    showMessage('Failed to load subscription', true);
    return null;
  }
}

function renderPlanSummary(res) {
  const el = $('#plan-summary');
  if (!el) return;

  const sub  = res.subscription;
  const tier = sub?.plan || res.subscription_tier || 'free';
  const status = sub?.status || 'none';
  const hasBillingAccount = Boolean(res?.has_billing_account);

  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  const badgeClass = tier === 'premium' ? 'premium' : tier === 'basic' ? 'basic' : 'free';

  let detail = '';
  if (!sub || tier === 'free') {
    detail = 'No active subscription — upgrade to start monitoring listings.';
    if (tier !== 'free') {
      detail = hasBillingAccount
        ? 'No active subscription — use Manage billing to resume or switch plans.'
        : 'Access tier is set, but no billing account is linked (test/manual mode).';
    }
  } else if (status === 'past_due') {
    detail = '⚠️ Payment past due — please update your billing details.';
  } else if (status === 'canceled') {
    detail = 'Subscription cancelled.';
  } else {
    const periodEnd = sub.current_period_end
      ? new Date(sub.current_period_end).toLocaleDateString()
      : null;
    const interval = sub.interval === 'year' ? 'yearly' : 'monthly';
    detail = `${interval.charAt(0).toUpperCase() + interval.slice(1)} billing${periodEnd ? ` · renews ${periodEnd}` : ''}${sub.cancel_at_period_end ? ' · cancels at period end' : ''}`;
  }

  el.innerHTML = `<span class="tier-badge ${badgeClass}">${tierLabel}</span>${detail}`;

  const manageBtn = $('#btn-manage-billing');
  if (manageBtn) {
    manageBtn.disabled = !hasBillingAccount;
    manageBtn.title = hasBillingAccount ? '' : 'No Stripe billing account is linked for this user.';
  }
}

function renderPlanCards(currentPlanKey) {
  const container = $('#plan-cards');
  if (!container) return;
  container.innerHTML = '';
  _selectedPlanKey = null;
  $('#btn-confirm-upgrade').disabled = true;

  Object.entries(PLAN_DISPLAY).forEach(([key, plan]) => {
    const isCurrent = key === currentPlanKey;
    const card = document.createElement('div');
    card.className = 'plan-card' + (isCurrent ? ' selected' : '');
    card.dataset.key = key;
    card.innerHTML = `
      <div class="plan-card-header">
        <div class="plan-radio"><div class="plan-radio-dot"></div></div>
        <span class="plan-name">${plan.name}${plan.badge ? `<span class="plan-badge-yearly">${plan.badge}</span>` : ''}</span>
        <span class="plan-price">${plan.price}</span>
      </div>
      <div class="plan-card-billing">${plan.billing}</div>
      <div class="plan-card-desc">${plan.desc}</div>
    `;
    card.addEventListener('click', () => {
      if (isCurrent) return; // can't reselect current plan
      container.querySelectorAll('.plan-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      _selectedPlanKey = key;
      $('#btn-confirm-upgrade').disabled = false;
    });
    container.appendChild(card);
  });
}

async function handleUpgradeClick() {
  const panel = $('#upgrade-panel');
  panel.classList.remove('hidden');
  $('#btn-upgrade').classList.add('hidden');

  // Work out which plan key is currently active
  const sub = _currentSubscription?.subscription;
  let currentKey = null;
  if (sub?.plan && sub?.interval) {
    currentKey = sub.plan + '_' + sub.interval + 'ly'; // e.g. basic_monthly
    if (sub.interval === 'year') currentKey = sub.plan + '_yearly';
  } else {
    const tier = _currentSubscription?.subscription_tier;
    if (tier === 'basic') currentKey = 'basic_monthly';
    if (tier === 'premium') currentKey = 'premium_monthly';
  }
  renderPlanCards(currentKey);
}

async function handleConfirmUpgrade() {
  if (!_selectedPlanKey) return;
  const btn = $('#btn-confirm-upgrade');
  setBtnLoading(btn, true, 'Redirecting…');
  try {
    track('checkout_started', { plan_key: _selectedPlanKey });
    const res = await apiRequest('POST', '/api/billing/checkout', { plan_key: _selectedPlanKey });
    if (res.url) {
      track('checkout_redirected', { plan_key: _selectedPlanKey });
      window.location.href = res.url;
    }
  } catch (err) {
    if (err.already_subscribed) {
      // Already subscribed — open portal to switch plans
      showMessage('Opening billing portal to switch plans…');
      await handleManageBilling();
    } else {
      track('checkout_failed', { plan_key: _selectedPlanKey, reason: err.error || 'unknown_error' });
      showMessage(err.error || 'Failed to start checkout', true);
    }
  } finally {
    setBtnLoading(btn, false);
  }
}

async function handleManageBilling() {
  const btn = $('#btn-manage-billing');
  setBtnLoading(btn, true, 'Opening portal…');
  try {
    const res = await apiRequest('POST', '/api/billing/portal');
    if (res.url) {
      track('billing_portal_opened', {});
      window.location.href = res.url;
    }
  } catch (err) {
    showMessage(err.error || 'Failed to open billing portal', true);
  } finally {
    setBtnLoading(btn, false);
  }
}

async function init() {
  // Wire up buttons
  $('#btn-logout').addEventListener('click', handleLogout);
  $('#btn-upgrade').addEventListener('click', handleUpgradeClick);
  $('#btn-manage-billing').addEventListener('click', handleManageBilling);
  $('#btn-confirm-upgrade').addEventListener('click', handleConfirmUpgrade);
  $('#btn-cancel-upgrade').addEventListener('click', () => {
    $('#upgrade-panel').classList.add('hidden');
    $('#btn-upgrade').classList.remove('hidden');
  });

  // Handle return from Stripe Checkout
  const urlParams = new URLSearchParams(window.location.search);
  const returningFromCheckout = urlParams.get('checkout');
  if (returningFromCheckout === 'success') {
    track('checkout_returned', { status: 'success' });
    showMessage('Payment received. Confirming your subscription…');
  }
  if (returningFromCheckout === 'cancelled') {
    track('checkout_returned', { status: 'cancelled' });
  }
  if (urlParams.get('checkout') === 'success') {
    // verify against server state after webhook processing
  } else if (urlParams.get('checkout') === 'cancelled') {
    showMessage('Checkout cancelled — no charge was made.', true);
    history.replaceState({}, '', '/billing');
  }

  const subData = await loadSubscription();
  if (returningFromCheckout === 'success') {
    const status = subData?.subscription?.status;
    if (status === 'active' || status === 'trialing') {
      track('checkout_succeeded', { subscription_status: status });
      showMessage('Payment successful — your plan is now active!');
    } else {
      track('checkout_processing', { subscription_status: status || 'unknown' });
      showMessage('Payment was completed, but activation is still processing. Refresh in a moment if needed.');
    }
    history.replaceState({}, '', '/billing');
  }
}

init();
