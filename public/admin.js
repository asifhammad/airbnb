  // ── Helpers ──────────────────────────────────────────────────────────────────
  const $ = sel => document.querySelector(sel);
  let currentTab = 'ops';
  let loginInFlight = false;

  function showMsg(msg, isError = false) {
    const el = $('#message');
    el.textContent = msg;
    el.className = `message ${isError ? 'error' : 'success'}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
  }

  function showInlineHelp(msg = '', isError = false) {
    const el = $('#auth-inline-help');
    if (!el) return;
    el.textContent = msg;
    el.className = isError ? 'error' : '';
  }

  function setAuthStatus(isLoggedIn, mode = '') {
    const statusEl = $('#auth-status');
    if (!statusEl) return;
    if (isLoggedIn) {
      statusEl.textContent = mode ? `Authenticated (${mode})` : 'Authenticated';
      statusEl.style.color = '#059669';
      return;
    }
    statusEl.textContent = 'Not authenticated';
    statusEl.style.color = '';
  }

  function setLoginLoading(loading) {
    loginInFlight = loading;
    const btn = $('#btn-login');
    if (!btn) return;
    if (loading) {
      btn.classList.add('loading');
      btn.textContent = 'Signing in...';
      btn.disabled = true;
      return;
    }
    btn.classList.remove('loading');
    btn.textContent = 'Login';
    updateLoginButtonState();
  }

  function updateLoginButtonState() {
    const btn = $('#btn-login');
    if (!btn || loginInFlight) return;
    btn.disabled = false;
  }

  function setAdminUiState(isLoggedIn, mode = '') {
    $('#btn-login').style.display = isLoggedIn ? 'none' : 'inline-block';
    $('#btn-logout').style.display = isLoggedIn ? 'inline-block' : 'none';
    $('#alerts-card').style.display = isLoggedIn ? 'block' : 'none';
    setAuthStatus(isLoggedIn, mode);
    if (!isLoggedIn) updateLoginButtonState();
  }

  function switchTab(tab) {
    currentTab = tab === 'analytics' ? 'analytics' : 'ops';
    document.querySelectorAll('.admin-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === currentTab);
    });
    $('#tab-ops').classList.toggle('hidden', currentTab !== 'ops');
    $('#tab-analytics').classList.toggle('hidden', currentTab !== 'analytics');
  }

  async function adminFetch(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function checkAdminSession() {
    try {
      const session = await adminFetch('/api/admin/session');
      setAdminUiState(true, session?.mode || '');
      return true;
    } catch (_) {
      setAdminUiState(false, '');
      return false;
    }
  }

  function renderProductAnalytics(data) {
    const statusEl = $('#posthog-status');
    const linksEl = $('#analytics-links');
    if (!statusEl || !linksEl) return;

    if (!data?.enabled) {
      statusEl.textContent = 'PostHog is not enabled (POSTHOG_PUBLIC_KEY missing).';
      linksEl.innerHTML = '';
      return;
    }

    const cards = [
      {
        key: 'signupFunnel',
        title: 'Signup Funnel',
        desc: 'Track signup start to verified account conversion.',
      },
      {
        key: 'checkoutFunnel',
        title: 'Checkout Funnel',
        desc: 'Monitor plan selection, checkout redirect, and payment completion.',
      },
      {
        key: 'alertCreationInsight',
        title: 'Alert Creation Success',
        desc: 'Measure how many users successfully create search alerts.',
      },
      {
        key: 'notificationCtrInsight',
        title: 'Notification Click-through',
        desc: 'Track engagement from in-app notifications to listing opens.',
      },
    ];

    statusEl.textContent = data.hasAnyLink
      ? 'PostHog is enabled. Open the links below.'
      : 'PostHog is enabled. Add insight URLs in env vars to make quick links available.';

    linksEl.innerHTML = cards.map((card) => {
      const href = data.links?.[card.key] || data.appHost || '';
      const button = href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer"><button type="button">Open in PostHog</button></a>`
        : `<button type="button" disabled>Link not configured</button>`;
      return `
        <article class="analytics-card">
          <h3 class="analytics-title">${card.title}</h3>
          <p class="analytics-desc">${card.desc}</p>
          ${button}
        </article>
      `;
    }).join('');
  }

  async function loginAdmin() {
    if (loginInFlight) return;
    showInlineHelp('');

    try {
      setLoginLoading(true);
      await adminFetch('/api/admin/login/session', { method: 'POST' });
      showMsg('Admin login successful');
      setAdminUiState(true, 'user_session');
      await loadDashboard();
    } catch (err) {
      setAdminUiState(false, '');
      showInlineHelp(err.message || 'Admin login failed', true);
      showMsg(err.message || 'Admin login failed', true);
    } finally {
      setLoginLoading(false);
    }
  }

  async function logoutAdmin() {
    try {
      await adminFetch('/api/admin/logout', { method: 'POST' });
    } catch (_) { /* ignore */ }
    setAdminUiState(false, '');
    showInlineHelp('');
    showMsg('Logged out');
  }

  function relTime(ts) {
    if (!ts) return '—';
    const diff = Math.round((Date.now() - new Date(ts)) / 1000);
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    return `${Math.round(diff / 86400)}d ago`;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString();
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────
  function renderStats(s, db) {
    const overdue = Number(s.overdue_premium_alerts);
    const failed  = Number(s.failed_emails_24h);
    const dbLabel = db
      ? (db.usingReplica ? `⚠️ Railway (fallback)` : `✅ Supabase (primary)`)
      : '—';
    const dbCls = db?.usingReplica ? 'warning' : 'ok';

    const cards = [
      { label: 'Database',            value: dbLabel,                    cls: dbCls },
      { label: 'Total users',         value: s.total_users,              cls: '' },
      { label: 'Active alerts',        value: s.active_alerts,            cls: '' },
      { label: 'Notifications 24h',    value: s.notifications_24h,        cls: '' },
      { label: 'Price drops 24h',      value: s.price_drops_24h,          cls: Number(s.price_drops_24h) > 0 ? 'ok' : '' },
      { label: 'Failed emails 24h',    value: s.failed_emails_24h,        cls: failed  > 0 ? 'danger'  : 'ok' },
      { label: 'Overdue premium',      value: s.overdue_premium_alerts,   cls: overdue > 0 ? 'warning' : 'ok' },
      { label: 'Listings cached',      value: s.total_listings_cached,    cls: '' },
    ];

    $('#stat-grid').innerHTML = cards.map(c => `
      <div class="stat-card ${c.cls}">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value">${c.value ?? '—'}</div>
      </div>
    `).join('');
  }

  // ── Alert table ───────────────────────────────────────────────────────────────
  let allAlerts = [];

  function renderAlerts(alerts) {
    allAlerts = alerts;
    applyFilter();
  }

  function applyFilter() {
    const onlyUnhealthy = $('#filter-unhealthy').checked;
    const rows = onlyUnhealthy ? allAlerts.filter(a => !a.healthy) : allAlerts;

    $('#alerts-tbody').innerHTML = rows.map(a => {
      const dotCls = a.healthy ? 'ok' : (a.issues.length > 1 ? 'error' : 'warn');
      const issues = a.issues.map(i => `<span class="issue-tag">${i}</span>`).join('');
      const mins   = a.mins_since_checked != null ? Math.round(Number(a.mins_since_checked)) : null;
      const lastChecked = mins != null
        ? (mins < 60 ? `${mins}m ago` : `${Math.round(mins/60)}h ago`)
        : '—';
      const loc = (a.location || a.search_url || '—').substring(0, 40);

      return `
        <tr data-id="${a.id}">
          <td><span class="status-dot ${dotCls}"></span></td>
          <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.user_email}</td>
          <td><span class="tier-pill ${a.subscription_tier}">${a.subscription_tier}</span></td>
          <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)">${loc}</td>
          <td style="white-space:nowrap;color:var(--muted)">${lastChecked}</td>
          <td>${a.known_listings}</td>
          <td>${a.total_price_drops}</td>
          <td>${a.notifications_last_48h}</td>
          <td>${issues || '<span style="color:var(--muted);font-size:12px">none</span>'}</td>
        </tr>`;
    }).join('');

    // Row click → detail panel
    $('#alerts-tbody').querySelectorAll('tr').forEach(tr => {
      tr.onclick = () => openDetail(tr.dataset.id);
    });
  }

  // ── Detail panel ─────────────────────────────────────────────────────────────
  async function openDetail(id) {
    $('#detail-panel').classList.remove('hidden');
    $('#detail-body').innerHTML = '<p style="color:var(--muted)">Loading…</p>';

    try {
      const data = await adminFetch(`/api/admin/alerts/${id}`);
      renderDetail(data);
    } catch (err) {
      $('#detail-body').innerHTML = `<p style="color:var(--danger)">${err.message}</p>`;
    }
  }

  function renderDetail({ alert: a, notifications, priceHistory, results }) {
    const alertMeta = [
      ['Alert ID',     a.id],
      ['Type',         a.alert_type],
      ['User',         a.email],
      ['Tier',         `<span class="tier-pill ${a.subscription_tier}">${a.subscription_tier}</span>`],
      ['Status',       a.is_active ? '✅ Active' : '⛔ Inactive'],
      ['Free trial',   a.is_free_trial ? `Yes (expires ${fmtDate(a.expires_at)})` : 'No'],
      ['Location',     a.location || '—'],
      ['Last checked', fmtDate(a.last_checked)],
      ['Last notified',fmtDate(a.last_notified)],
      ['Total notifs', a.notification_count],
      ['Check-in',     a.check_in  ? a.check_in.split('T')[0]  : '—'],
      ['Check-out',    a.check_out ? a.check_out.split('T')[0] : '—'],
      ['Price range',  (a.price_min || a.price_max) ? `$${a.price_min||0} – $${a.price_max||'∞'}` : '—'],
    ];

    // Price history chain
    let historyHtml = '<p style="color:var(--muted);font-size:13px">No price history yet.</p>';
    if (priceHistory && priceHistory.length) {
      // Group by listing_id
      const byListing = {};
      priceHistory.forEach(r => {
        if (!byListing[r.listing_id]) byListing[r.listing_id] = [];
        byListing[r.listing_id].push(r);
      });
      historyHtml = Object.entries(byListing).slice(0, 10).map(([lid, rows]) => {
        const prices = rows.map((r, i) => {
          const val = Number(r.price).toFixed(0);
          const prev = i > 0 ? Number(rows[i-1].price) : null;
          const cls  = prev == null ? '' : (Number(r.price) < prev ? 'down' : Number(r.price) > prev ? 'up' : '');
          return `<span class="${cls}">$${val}</span>`;
        }).join(' → ');
        return `<div style="margin-bottom:6px">
          <span style="font-size:11px;color:var(--muted)">Listing ${lid}:</span>
          <div class="price-chain">${prices}</div>
        </div>`;
      }).join('');
    }

    // Recent notifications
    let notifHtml = '<p style="color:var(--muted);font-size:13px">No notifications yet.</p>';
    if (notifications && notifications.length) {
      notifHtml = notifications.map(n => {
        const priceStr = (n.old_price && n.new_price)
          ? `<span style="color:#10b981">$${Number(n.old_price).toFixed(0)} → $${Number(n.new_price).toFixed(0)}</span>`
          : '';
        const failedStr = n.email_sent === false
          ? `<span style="color:#ef4444;font-size:11px"> ✗ email failed</span>` : '';
        return `<div class="notif-row">
          <div>
            <span class="notif-type ${n.notification_type}">${n.notification_type.replace(/_/g,' ')}</span>
            ${priceStr} ${failedStr}
            <div style="font-size:11px;color:var(--muted);margin-top:2px">Listing ${n.listing_id||'—'}</div>
          </div>
          <div class="notif-meta">${relTime(n.sent_at)}</div>
        </div>`;
      }).join('');
    }

    // Recent results
    let resultsHtml = '<p style="color:var(--muted);font-size:13px">No results yet.</p>';
    if (results && results.length) {
      resultsHtml = results.map(r => {
        const priceStr = r.change_type === 'price_drop'
          ? `<span style="color:#10b981"> $${Number(r.old_price).toFixed(0)}→$${Number(r.new_price).toFixed(0)}</span>` : '';
        return `<div class="notif-row">
          <div>
            <span style="font-weight:600;color:var(--text)">${r.change_type}</span>${priceStr}
            <div style="font-size:11px;color:var(--muted);margin-top:2px">${r.name || r.listing_id}</div>
          </div>
          <div class="notif-meta">${relTime(r.detected_at)}</div>
        </div>`;
      }).join('');
    }

    $('#detail-body').innerHTML = `
      <h3 style="margin:0 0 16px 0">Alert #${a.id}</h3>

      <div class="detail-section">
        <h4>Overview</h4>
        ${alertMeta.map(([k,v]) => `
          <div class="detail-row">
            <span class="detail-key">${k}</span>
            <span class="detail-val">${v}</span>
          </div>`).join('')}
      </div>

      <div class="detail-section">
        <h4>Price history (last 50 points, up to 10 listings)</h4>
        ${historyHtml}
      </div>

      <div class="detail-section">
        <h4>Recent notifications</h4>
        ${notifHtml}
      </div>

      <div class="detail-section">
        <h4>Recent scrape results</h4>
        ${resultsHtml}
      </div>
    `;
  }

  // ── Load everything ───────────────────────────────────────────────────────────
  async function loadDashboard() {
    const hasSession = await checkAdminSession();
    if (!hasSession) {
      showMsg('Login as admin first', true);
      return;
    }

    const btn = $('#btn-refresh');
    btn.classList.add('loading');
    btn.textContent = 'Loading…';

    try {
      const [statsData, alertsData, analyticsData] = await Promise.all([
        adminFetch('/api/admin/stats'),
        adminFetch('/api/admin/alerts'),
        adminFetch('/api/admin/product-analytics'),
      ]);

      renderStats(statsData.stats, statsData.db);
      renderProductAnalytics(analyticsData);

      const { summary, alerts } = alertsData;
      $('#summary-counts').textContent =
        `${summary.total} total · ${summary.healthy} healthy · ${summary.unhealthy} unhealthy`;

      // Health banner
      const banner = $('#health-banner');
      if (summary.unhealthy === 0) {
        banner.className = 'ok';
        banner.textContent = `✅ All ${summary.total} alerts are healthy`;
        banner.style.display = 'block';
      } else {
        banner.className = 'warning';
        banner.textContent = `⚠️ ${summary.unhealthy} alert${summary.unhealthy > 1 ? 's' : ''} need attention`;
        banner.style.display = 'block';
      }

      renderAlerts(alerts);
      $('#alerts-card').style.display = 'block';

    } catch (err) {
      showMsg(err.message || 'Failed to load dashboard', true);
    } finally {
      btn.classList.remove('loading');
      btn.textContent = '↻ Refresh';
    }
  }

  // ── Wire up ───────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    $('#btn-login').onclick   = loginAdmin;
    $('#btn-logout').onclick  = logoutAdmin;
    $('#btn-refresh').onclick = loadDashboard;

    $('#filter-unhealthy').onchange = applyFilter;
    document.querySelectorAll('.admin-tab').forEach((btn) => {
      btn.onclick = () => switchTab(btn.dataset.tab);
    });

    // Detail panel close
    $('#detail-close').onclick    = () => $('#detail-panel').classList.add('hidden');
    $('#detail-backdrop').onclick = () => $('#detail-panel').classList.add('hidden');
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') $('#detail-panel').classList.add('hidden');
    });

    // Auto-load dashboard if cookie session already exists.
    checkAdminSession().then((ok) => {
      if (ok) loadDashboard();
    });
    updateLoginButtonState();
    switchTab('ops');
  });
