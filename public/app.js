const $ = (sel) => document.querySelector(sel);
const analytics = window.analytics || null;
let currentUserTier = null;

function track(event, props) {
  try { analytics?.track?.(event, props || {}); } catch (_) { /* no-op */ }
}

function identifyUser(distinctId, props) {
  try { analytics?.identify?.(distinctId, props || {}); } catch (_) { /* no-op */ }
}

function isAirbnbHostname(hostname) {
  if (!hostname) return false;
  const normalized = String(hostname).toLowerCase();
  return normalized === 'airbnb.com' || normalized.endsWith('.airbnb.com');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeExternalUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

/**
 * Central API helper. Auth is handled entirely via HttpOnly cookies — no tokens
 * in JS. On a 401 we attempt one silent refresh (POST /api/auth/refresh, which
 * also uses a cookie), then retry. If that fails we redirect to /auth.
 */
async function apiRequest(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin', // always send cookies
  };

  let res  = await fetch(path, opts);
  let json = await res.json().catch(() => ({}));
  if (res.ok) return json;

  // On 401 try a silent token refresh then replay the original request once
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
      // Refresh token is gone or expired — send to login
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

async function handleLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* ignore */ }
  // Clear non-sensitive UI state from localStorage
  localStorage.removeItem('lastPreview');
  window.location.href = '/auth';
}

async function createUrlAlert() {
  const btn = $('#btn-create-url-alert');
  // Prevent free/basic users from creating >1 search — show upgrade modal instead
  try {
    const ok = await ensureCanCreateSearchAlert();
    if (!ok) return;
  } catch (e) {
    // if check fails, allow backend to enforce limits
  }
  setBtnLoading(btn, true, 'Saving...');
  try {
    const search_url = $('#alert-search-url').value.trim();
    if (!search_url) return showMessage('Please paste an Airbnb search URL', true);
    let parsedUrl;
    try {
      parsedUrl = new URL(search_url);
    } catch (e) {
      return showMessage('Please enter a valid URL', true);
    }
    if (!isAirbnbHostname(parsedUrl.hostname)) return showMessage('URL must be from airbnb.com', true);
    const res = await apiRequest('POST', '/api/alerts/url', { search_url });
    track('alert_created', { source: 'search_url', is_free_trial: Boolean(res?.is_free_trial) });
    
    // Show appropriate message based on alert type
    if (res.is_free_trial) {
      showMessage('Free alert created! This alert will expire in 24 hours. Upgrade to create permanent alerts.');
    } else {
      showMessage(res.message || 'Alert saved!');
    }
    
    $('#alert-search-url').value = '';
  const previewEl = $('#alert-search-preview'); if (previewEl) { previewEl.classList.add('hidden'); previewEl.setAttribute('aria-hidden', 'true'); previewEl.textContent = ''; }
    loadAlerts();
    try {
      if (currentUserTier !== 'premium') showAlertCreatedModal();
    } catch (e) { /* ignore */ }
  } catch (err) {
    if (err.upgrade_required) {
      showMessage(err.error, true);
      // Redirect to billing page to upgrade
      setTimeout(() => {
        window.location.href = '/billing';
      }, 1500);
    } else {
      showMessage(err.error || JSON.stringify(err), true);
    }
  } finally {
    setBtnLoading(btn, false);
  }
}

// (Listing-specific alert UI removed — only URL/search alerts remain in the frontend)

// (Listing-specific alert UI removed — only URL/search alerts remain in the frontend)

// Parse a full Airbnb search URL and return important filters (client-side)
function parseAirbnbSearchUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (!isAirbnbHostname(url.hostname)) return null;
    const sp = url.searchParams;
    const asInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
    const adults = asInt(sp.get('adults')) || 0;
    const children = asInt(sp.get('children')) || 0;
    const guests = (adults + children) || asInt(sp.get('guests')) || null;
    const amenities = sp.getAll('amenities[]').length ? sp.getAll('amenities[]') : sp.getAll('amenities');
    const price_min = asInt(sp.get('price_min')) || null;
    const price_max = asInt(sp.get('price_max')) || null;
    const check_in = sp.get('checkin') || sp.get('check_in') || null;
    const check_out = sp.get('checkout') || sp.get('check_out') || null;
    const monthly_start_date = sp.get('monthly_start_date') || null;
    const monthly_length = asInt(sp.get('monthly_length')) || null;
    let monthly_end_date = sp.get('monthly_end_date') || null;
    if (monthly_start_date && monthly_length) {
      try {
        const parts = monthly_start_date.split('-').map(Number);
        if (parts.length === 3) {
          const d = new Date(parts[0], parts[1] - 1, parts[2]);
          const end = new Date(d.getFullYear(), d.getMonth() + monthly_length, d.getDate());
          end.setDate(end.getDate() - 1);
          const yyyy = end.getFullYear();
          const mm = String(end.getMonth() + 1).padStart(2, '0');
          const dd = String(end.getDate()).padStart(2, '0');
          monthly_end_date = `${yyyy}-${mm}-${dd}`;
        }
      } catch (e) { /* ignore */ }
    }
    const location = sp.get('query') || null;
    return { location, check_in, check_out, guests, amenities, price_min, price_max, monthly_start_date, monthly_length, monthly_end_date, monthly_search: !!(monthly_start_date || monthly_length), rawParams: Object.fromEntries(sp.entries()) };
  } catch (e) { return null; }
}

function showSearchUrlPreview() {
  try {
    const el = $('#alert-search-url');
    if (!el) return;
    const previewEl = $('#alert-search-preview');
    const parsed = parseAirbnbSearchUrl(el.value.trim());
    // hide preview when nothing parseable
    if (!previewEl) {
      // no inline preview container available — nothing to do
      return;
    }

    if (!parsed) {
      previewEl.classList.add('hidden');
      previewEl.setAttribute('aria-hidden', 'true');
      previewEl.textContent = '';
      return;
    }

    // build inline preview nodes (safe textContent usage)
    previewEl.innerHTML = '';
    if (parsed.location) {
      const l = document.createElement('span'); l.className = 'loc'; l.textContent = parsed.location; previewEl.appendChild(l);
    }
    if (parsed.check_in && parsed.check_out) {
      const d = document.createElement('span'); d.className = 'badge date-range'; d.textContent = `${formatDateForDisplay(parsed.check_in)} → ${formatDateForDisplay(parsed.check_out)}`; previewEl.appendChild(d);
    }
  
    if (parsed.guests) {
      const g = document.createElement('span'); g.className = 'small'; g.textContent = `${parsed.guests} guests`; previewEl.appendChild(g);
    }
    if (parsed.price_min || parsed.price_max) {
      const p = document.createElement('span'); p.className = 'small'; p.textContent = `$${parsed.price_min || '0'}–${parsed.price_max || '∞'}`; previewEl.appendChild(p);
    }

    previewEl.classList.remove('hidden');
    previewEl.setAttribute('aria-hidden', 'false');
  } catch (e) { /* ignore */ }
}

// Normalize/format date strings for display in the UI (keep YYYY-MM-DD)
function formatDateForDisplay(d) {
  if (!d) return '';
  try {
    const s = String(d);
    // If it's an ISO with time (2026-03-02T00:00:00.000Z) just take the date portion
    if (s.indexOf('T') !== -1) return s.split('T')[0];
    // If already YYYY-MM-DD, return as-is
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // Fallback: try to parse and format as YYYY-MM-DD
    const dt = new Date(s);
    if (Number.isNaN(dt.getTime())) return s;
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch (e) {
    return String(d);
  }
}

function getAlertTitle(a) {
  if (!a) return 'Alert';

  if (a.location && String(a.location).trim()) return String(a.location).trim();
  if (a.listing_url && String(a.listing_url).trim()) return String(a.listing_url).trim();
  if (a.search_url && String(a.search_url).trim()) {
    try {
      const u = new URL(a.search_url);
      const query = u.searchParams.get('query');
      if (query && query.trim()) return query.trim();
      return `${u.hostname}${u.pathname}`;
    } catch (e) {
      return String(a.search_url).trim();
    }
  }
  if (a.listing_id) return `Listing ${a.listing_id}`;
  if (a.id) return `Alert #${a.id}`;
  return 'Alert';
}

function renderAlerts(alerts) {
  const container = $('#alerts-list');
  if (!alerts || alerts.length === 0) {
    container.innerHTML = '<i>No alerts yet</i>';
    return;
  }

  container.innerHTML = '';
  alerts.forEach((a) => {
    const div = document.createElement('div');
    div.className = 'alert-item';
    
    // Show expiration for free trial alerts
    let expirationInfo = '';
    if (a.is_free_trial && a.expires_at) {
      // Show run-frequency hint only when the alert is active.
      expirationInfo = isActive
        ? `<span class="badge free-trial">Running 1x per day</span>`
        : '';
    }
    
    const title = escapeHtml(getAlertTitle(a));
    const isActive = a.is_active !== false;
    const typeLabel = escapeHtml(a.alert_type === 'listing' ? 'Listing alert' : 'Search alert');
    const statusBadge = `<span class="badge ${isActive ? '' : 'free-trial'}">${isActive ? 'Active' : 'Paused'}</span>`;
    const checkMeta = escapeHtml(a.last_checked ? `Last checked ${new Date(a.last_checked).toLocaleString()}` : 'Not checked yet');
    const notifMeta = Number.isFinite(Number(a.notification_count))
      ? `${escapeHtml(a.notification_count)} notifications`
      : escapeHtml('0 notifications');
    const controlsHtml = `
        <div class="controls">
          ${a.alert_type === 'search' ? `<button data-id="${escapeHtml(a.id)}" class="btn-see-search">See your search</button>` : ''}
          <button data-id="${escapeHtml(a.id)}" class="btn-unsubscribe">Unsubscribe</button>
        </div>
      `;
    
    div.innerHTML = `
        <div class="meta">
              ${a.check_in && a.check_out ? `<span class="badge date-range">${formatDateForDisplay(a.check_in)} → ${formatDateForDisplay(a.check_out)}</span>` : ''}
              <span class="badge">${typeLabel}</span>
              ${statusBadge}
              ${expirationInfo}
            </div>
        <div>${title}</div>
        <div style="color:var(--muted);font-size:12px">${checkMeta} · ${notifMeta}</div>
        ${controlsHtml}
      `;
    container.appendChild(div);
  });
  
  console.log('Rendered alerts:', alerts.length);

  document.querySelectorAll('.btn-unsubscribe').forEach((btn) => {
    btn.onclick = async (e) => {
      const id = e.target.dataset.id;
      try {
        await apiRequest('DELETE', `/api/alerts/${id}`);
        showMessage('Unsubscribed');
        loadAlerts();
      } catch (err) {
        showMessage(err.error || JSON.stringify(err), true);
      }
    };
  });

  // (manual "Run now" no longer available in the UI)

  document.querySelectorAll('.btn-see-search').forEach((btn) => {
    btn.onclick = async (e) => {
      const id = e.target.dataset.id;
      track('alert_search_view_clicked', { search_alert_id: Number(id) || null });
      const alertItem = alerts.find(x => x.id == id) || {};
      const url = alertItem.search_url || alertItem.searchUrl || '';
      if (!url) return showMessage('No search URL available', true);
      showSearchModal(url);
    };
  });
}

async function createSearchAlert() {
  const btn = $('#btn-create-search');
  // Prevent free/basic users from creating >1 search — show upgrade modal instead
  try {
    const ok = await ensureCanCreateSearchAlert();
    if (!ok) return;
  } catch (e) { /* allow server-side enforcement */ }
  setBtnLoading(btn, true, 'Creating...');
  try {
    const location = $('#search-location').value;
    const check_in = $('#search-check-in').value;
    const check_out = $('#search-check-out').value;
    const price_min = $('#price-min').value ? parseInt($('#price-min').value, 10) : null;
    const price_max = $('#price-max').value ? parseInt($('#price-max').value, 10) : null;
    const guests = $('#guests').value ? parseInt($('#guests').value, 10) : 1;

    if (!location || !check_in || !check_out) {
      return showMessage('Location and dates are required', true);
    }

    await apiRequest('POST', '/api/alerts/search', { location, check_in, check_out, price_min, price_max, guests });
    showMessage('Search alert created');
    loadAlerts();
  } catch (err) {
    showMessage(err.error || JSON.stringify(err), true);
  } finally {
    setBtnLoading(btn, false);
  }
}

async function viewListingsForAlert(alertId) {
  try {
    $('#listings-for-id').textContent = alertId;
    const res = await apiRequest('GET', `/api/listings/alert/${alertId}`);
    renderListings(res.listings || []);
    document.getElementById('listings-panel').classList.remove('hidden');
  } catch (err) {
    showMessage(err.error || JSON.stringify(err), true);
  }
}

// --- DB-backed listings (alerts) ---
function renderListings(listings) {
  const container = $('#listings-list');
  if (!listings || listings.length === 0) {
    container.innerHTML = '<i>No listings yet — wait a few seconds</i>';
    return;
  }

  container.innerHTML = '';
  const total = listings.length || 0;
  const header = document.createElement('div');
  header.style.marginBottom = '8px';
  header.style.color = 'rgba(255,255,255,0.6)';
  header.textContent = `Showing ${Math.min(total, 50)} of ${total} listings`;
  container.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'listing-grid';
  container.appendChild(grid);

  listings.slice(0, 50).forEach((l) => {
    const id = l.listing_id || l.listingid || l.id || '';
    const card = document.createElement('div');
    card.className = 'listing-card';
    const photoUrlRaw = (l.photos && l.photos.length) ? (l.photos[0].url || l.photos[0]) : '';
    const photoUrl = sanitizeExternalUrl(photoUrlRaw);
    const listingUrl = sanitizeExternalUrl(l.url || (id ? `https://www.airbnb.com/rooms/${id}` : ''));
    const listingName = escapeHtml(l.name || 'listing');
    const listingAddress = escapeHtml((l.address || '').substring(0, 120));
    const ratingValue = escapeHtml(l.rating ? (l.rating.guest_satisfaction || l.rating) : '—');
    const priceText = escapeHtml(
      l.price
        ? (typeof l.price === 'object' ? ('$' + (l.price.unit?.amount || l.price.amount || '')) : ('$' + l.price))
        : ''
    );
    card.innerHTML = `
      <div class="listing-thumb">
        ${photoUrl ? `${listingUrl ? `<a href="${listingUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open listing in Airbnb">` : ''}<img src="${photoUrl}" loading="lazy" alt="${listingName}">${listingUrl ? `</a>` : ''}` : ''}
        <div class="price-badge">${priceText}</div>
      </div>
      <div class="listing-meta">
        <div class="listing-title">${listingName || '—'}</div>
        <div class="listing-sub">${listingAddress}</div>
        <div style="margin-top:8px">
          <span class="rating">⭐ ${ratingValue}</span>
        </div>
        <div class="listing-actions">
          <button data-id="${escapeHtml(id)}" class="btn-open-details">Details</button>
          <button data-url="${listingUrl}" class="btn-share">Share</button>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });

  // (inline "Save listing" action removed from UI)

  document.querySelectorAll('.btn-open-details').forEach((btn) => {
    btn.onclick = async (e) => {
      const listingId = e.target.dataset.id;
      showListingModal(listingId);
    };
  });

  document.querySelectorAll('.btn-share').forEach((btn) => {
    btn.onclick = (e) => {
      const url = e.target.dataset.url;
      if (!url) return showMessage('No shareable URL for this listing', true);
      navigator.clipboard?.writeText(url).then(() => showMessage('Listing URL copied to clipboard'))
        .catch(() => showMessage('Could not copy URL', true));
    };
  });
}

// --- Preview results (server-side pagination) ---
let previewState = { params: null, page: 1, pageSize: 20, total: 0, results: [] };
// set when the user picks a location from the autocomplete suggestions
let selectedLocation = null;

// Persist last preview search so the dashboard can restore it after a refresh.
function savePreviewToLocalStorage() {
  if (!previewState || !previewState.params) return;
  try {
    const payload = {
      params: previewState.params,
      page: previewState.page || 1,
      pageSize: previewState.pageSize || 20,
      selectedLocation: selectedLocation ? { display_name: selectedLocation.display_name, boundingbox: selectedLocation.boundingbox } : null,
      savedAt: Date.now()
    };
    localStorage.setItem('lastPreview', JSON.stringify(payload));
  } catch (e) { /* ignore */ }
}

function loadPreviewFromLocalStorage() {
  // Preview state restoration is only relevant if the search panel exists
  if (!$('#page-size')) return null;
  try {
    const raw = localStorage.getItem('lastPreview');
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || !saved.params) return null;
    previewState.params    = saved.params;
    previewState.page      = saved.page || 1;
    previewState.pageSize  = saved.pageSize || previewState.pageSize;
    const ps = $('#page-size'); if (ps) ps.value = previewState.pageSize;
    return saved;
  } catch (e) { return null; }
}

// Client-side location autocomplete (Nominatim). Keeps a small in-memory
// suggestions box and exposes the chosen result via `selectedLocation`.
function initLocationAutocomplete() {
  const input = $('#search-location');
  const suggBox = $('#location-suggestions');
  if (!input || !suggBox) return;

  let debounceTimer = null;
  let currentResults = [];
  let highlighted = -1;

  input.addEventListener('input', () => {
    selectedLocation = null; // clear previous selection when typing
    const q = input.value.trim();
    if (!q || q.length < 2) { suggBox.classList.add('hidden'); suggBox.innerHTML = ''; return; }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=0&limit=6`;
        const res = await fetch(url);
        const arr = await res.json().catch(() => []);
        currentResults = Array.isArray(arr) ? arr : [];

        if (!currentResults.length) {
          suggBox.innerHTML = '<div class="note" style="padding:8px">No results</div>';
          suggBox.classList.remove('hidden');
          return;
        }

        suggBox.innerHTML = currentResults.map((it, i) => `<div class="suggestion-item" data-idx="${i}">${it.display_name}</div>`).join('');
        suggBox.classList.remove('hidden');
        highlighted = -1;
      } catch (err) {
        console.error('location autocomplete error', err);
        suggBox.classList.add('hidden');
      }
    }, 300);
  });

  // keyboard navigation inside suggestions
  input.addEventListener('keydown', (ev) => {
    const items = Array.from(suggBox.querySelectorAll('.suggestion-item'));
    if (!items.length) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault(); highlighted = Math.min(items.length - 1, highlighted + 1);
      items.forEach(i => i.classList.remove('highlight'));
      items[highlighted].classList.add('highlight');
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault(); highlighted = Math.max(0, highlighted - 1);
      items.forEach(i => i.classList.remove('highlight'));
      items[highlighted].classList.add('highlight');
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const idx = highlighted >= 0 ? highlighted : 0;
      const item = items[idx];
      if (item) item.click();
    } else if (ev.key === 'Escape') {
      suggBox.classList.add('hidden');
    }
  });

  // click/select a suggestion
  suggBox.addEventListener('click', (ev) => {
    const item = ev.target.closest('.suggestion-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx, 10);
    const sel = currentResults[idx];
    if (!sel) return;
    // short display in input, keep full result in selectedLocation
    input.value = sel.display_name.split(',').slice(0, 3).join(', ');
    selectedLocation = sel;
    suggBox.classList.add('hidden');
  });

  // hide when clicking elsewhere
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#location-suggestions') && ev.target !== input) {
      suggBox.classList.add('hidden');
    }
  });
}

async function fetchPreviewPage(page = 1) {
  if (!previewState.params) return;
  previewState.page = Math.max(1, page);
  previewState.pageSize = parseInt($('#page-size').value, 10) || previewState.pageSize;

  const container = $('#listings-list');
  // skeleton while fetching (grid)
  container.innerHTML = '';
  const skGrid = document.createElement('div');
  skGrid.className = 'listing-grid';
  const skeletonCount = Math.min(8, previewState.pageSize || 6);
  for (let i = 0; i < skeletonCount; i++) {
    const sk = document.createElement('div');
    sk.className = 'listing-card skeleton-card';
    sk.innerHTML = `<div class="skeleton skeleton-thumb"></div><div style="flex:1"><div class="skeleton-line" style="width:60%"></div><div class="skeleton-line" style="width:40%"></div></div>`;
    skGrid.appendChild(sk);
  }
  container.appendChild(skGrid);

  try {
    const body = Object.assign({}, previewState.params, { page: previewState.page, pageSize: previewState.pageSize });
    const res = await apiRequest('POST', '/api/listings/search', body);
    const results = res.results || [];
    previewState.results = results;
    previewState.total = res.total || results.length || 0;
    renderPreviewResults(results, previewState.total);
    // persist the last preview (params + page) so reload restores it
    try { savePreviewToLocalStorage(); } catch (e) { /* ignore */ }
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger)">Search failed: ${err.error || err.message || JSON.stringify(err)}</div>`;
  }
}

function renderPreviewResults(results, total) {
  const container = $('#listings-list');
  if (!results || results.length === 0) {
    container.innerHTML = '<i>No results — try a different date or location</i>';
    previewState.results = [];
    previewState.total = total || 0;
    $('#btn-prev-page').disabled = true;
    $('#btn-next-page').disabled = true;
    return;
  }

  container.innerHTML = '';
  const start = (previewState.page - 1) * previewState.pageSize;
  const end = Math.min(previewState.total, start + results.length);

  const header = document.createElement('div');
  header.style.marginBottom = '8px';
  header.style.color = 'var(--muted)';
  header.textContent = `Showing ${start + 1}–${end} of ${previewState.total} results`;
  container.appendChild(header);

  // results grid
  const grid = document.createElement('div');
  grid.className = 'listing-grid';
  container.appendChild(grid);

  // debug output (visible during development) — raw API response
  try {
    const dbg = $('#preview-debug');
    // only show debug JSON when explicitly enabled in the browser (localStorage.debug === '1')
    if (dbg) {
      if (localStorage.getItem('debug') === '1') {
        dbg.textContent = JSON.stringify({ total, page: previewState.page, pageSize: previewState.pageSize, resultsCount: results.length }, null, 2);
        dbg.classList.remove('hidden');
      } else {
        dbg.classList.add('hidden');
      }
    }
  } catch (e) { /* ignore */ }

  results.forEach((l) => {
    const id = l.id || l.listing_id || '';
  const photoUrl = sanitizeExternalUrl((l.photos && l.photos.length) ? (l.photos[0].url || l.photos[0]) : '');
  // compute badges (server already added isSaved/isSuperhost/_priceAmount/_reviewsCount)
    const badges = [];
    if (l.isSaved) badges.push('<span class="badge saved">Saved</span>');
    if (l.isSuperhost) badges.push('<span class="badge superhost">Superhost</span>');
    // popularity/premium heuristics (also can be set server-side via filters)
    const priceAmt = l._priceAmount || (l.price && (l.price.unit?.amount || l.price.amount || (l.price.total && l.price.total.amount))) || 0;
    const reviews = l._reviewsCount || 0;
    const ratingVal = l._ratingValue || (l.rating && l.rating.value) || 0;
    if (priceAmt >= (previewState.params?.premium_min_price || previewState.params?.min_price || 200)) badges.push('<span class="badge premium">Premium</span>');
    if (reviews >= (previewState.params?.popular_min_reviews || 50) || (ratingVal >= (previewState.params?.popular_min_rating || 4.7) && reviews >= 10)) badges.push('<span class="badge popular">Popular</span>');

    const listingUrl = sanitizeExternalUrl(l.url || (id ? `https://www.airbnb.com/rooms/${id}` : ''));
    const listingName = escapeHtml(l.name || 'listing');
    const listingSub = escapeHtml((l.address || l.url || '').substring(0, 120));
    const ratingValue = escapeHtml(l.rating ? (l.rating.guest_satisfaction || l.rating.value || l.rating) : '—');
    const priceText = escapeHtml(
      l.price
        ? (typeof l.price === 'object' ? ('$' + (l.price.unit?.amount || l.price.amount || '')) : ('$' + l.price))
        : ''
    );
    const card = document.createElement('div');
    card.className = 'listing-card';
    card.innerHTML = `
      <div class="listing-thumb">
        ${photoUrl ? `${listingUrl ? `<a href="${listingUrl}" target="_blank" rel="noopener noreferrer" aria-label="Open listing in Airbnb">` : ''}<img src="${photoUrl}" loading="lazy" alt="${listingName}">${listingUrl ? `</a>` : ''}` : ''}
        <div class="price-badge">${priceText}</div>
      </div>
      <div class="listing-meta">
        <div style="display:flex;gap:8px;align-items:center">
          <div class="listing-title">${listingName || '—'}</div>
          <div>${badges.join('')}</div>
        </div>
        <div class="listing-sub">${listingSub}</div>
        <div style="margin-top:8px">
          <span class="rating">⭐ ${ratingValue}</span>
        </div>
        <div class="listing-actions">
          <button data-id="${escapeHtml(id)}" class="btn-open-details">Details</button>
          <button data-url="${listingUrl}" class="btn-share">Share</button>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });

  // wire up buttons
  // (inline "Save listing" action removed from preview results)

  document.querySelectorAll('.btn-open-details').forEach((btn) => {
    btn.onclick = (e) => showListingModal(e.target.dataset.id);
  });

  document.querySelectorAll('.btn-share').forEach((btn) => {
    btn.onclick = (e) => {
      const url = e.target.dataset.url;
      if (!url) return showMessage('No shareable URL for this listing', true);
      navigator.clipboard?.writeText(url).then(() => showMessage('Listing URL copied to clipboard'))
        .catch(() => showMessage('Could not copy URL', true));
    };
  });

  // pagination control state
  const maxPage = Math.ceil((previewState.total || 0) / previewState.pageSize) || 1;
  $('#btn-prev-page').disabled = previewState.page <= 1;
  $('#btn-next-page').disabled = previewState.page >= maxPage;
}

async function loadNotifications() {
  try {
    const res = await apiRequest('GET', '/api/listings/notifications/recent');
    const container = $('#notifications-list');
    if (!res.notifications || res.notifications.length === 0) {
      container.innerHTML = '<i>No notifications yet</i>';
      return;
    }
    track('notifications_loaded', { count: res.notifications.length });
    container.innerHTML = res.notifications.map(n => {
      const isPriceDrop = n.notification_type === 'price_drop';
      const priceChange = (isPriceDrop && n.old_price && n.new_price)
        ? `<span style="color:#48bb78;margin-left:8px">&#x25bc; ${escapeHtml((n.old_price - n.new_price).toFixed(0))} (${escapeHtml(Number(n.old_price).toFixed(0))} → ${escapeHtml(Number(n.new_price).toFixed(0))})</span>`
        : '';
      const listingName = escapeHtml(n.listing_name || n.listing_id || 'Listing');
      const listingUrl = sanitizeExternalUrl(n.listing_url || '');
      const listingImage = sanitizeExternalUrl(n.listing_image_url || '');
      const canOpenModal = !!(n.listing_id && /^\d+$/.test(String(n.listing_id)));
      const notifType = escapeHtml(String(n.notification_type || '').replace('_', ' '));
      const listingId = escapeHtml(String(n.listing_id || ''));
      return `
        <div class="alert-item">
          <div style="display:flex;gap:10px;align-items:flex-start">
            ${listingImage ? `<img src="${listingImage}" alt="${listingName}" loading="lazy" style="width:84px;height:64px;object-fit:cover;border-radius:8px;border:1px solid rgba(16,24,40,0.08)">` : ''}
            <div style="flex:1;min-width:0">
              <div>
                <strong>${notifType}</strong>
                — ${listingName}
                ${priceChange}
              </div>
              <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">
                ${canOpenModal ? `<button class="secondary btn-view-listing" data-listing-id="${listingId}">View Listing</button>` : ''}
                ${listingUrl ? `<button class="secondary btn-open-airbnb" type="button" data-listing-url="${listingUrl}" data-listing-id="${listingId}">Open Airbnb</button>` : ''}
              </div>
            </div>
          </div>
          <div style="color:var(--muted)">${new Date(n.sent_at).toLocaleString()}</div>
        </div>`;
    }).join('');

    document.querySelectorAll('.btn-view-listing').forEach((btn) => {
      btn.onclick = (e) => showListingModal(e.currentTarget.dataset.listingId);
    });

    document.querySelectorAll('.btn-open-airbnb').forEach((btn) => {
      btn.onclick = (e) => {
        const listingUrl = e.currentTarget.dataset.listingUrl;
        const listingId = e.currentTarget.dataset.listingId;
        track('notification_open_airbnb_clicked', {
          listing_id: listingId || null,
          source: 'notifications_feed',
        });
        if (!listingUrl) return;
        window.open(listingUrl, '_blank', 'noopener,noreferrer');
      };
    });
  } catch (err) {
    console.error(err);
  }
}

async function loadAlerts() {
  try {
    const res = await apiRequest('GET', '/api/alerts');
    const alerts = Array.isArray(res?.alerts) ? res.alerts : (Array.isArray(res) ? res : []);
    renderAlerts(alerts);
    document.getElementById('alerts-card').classList.remove('hidden');
    // Keep notifications feed synchronized with alert counters.
    loadNotifications();
  } catch (err) {
    console.error('Failed to load alerts:', err);
    showMessage('Failed to load alerts — are you logged in?', true);
  }
}



async function showLoggedInState() {
  // Show user menu
  document.getElementById('user-menu-btn').classList.remove('hidden');

  // Fetch user info from the server (cookie handles auth — no token parsing needed)
  let tier = null;
  try {
    const res = await apiRequest('GET', '/api/auth/me');
    if (res && res.user) {
      tier = res.user.subscription_tier || null;
      currentUserTier = tier;
      identifyUser(res.user.id || res.user.email || 'user', {
        email: res.user.email || null,
        subscription_tier: tier || null,
      });
      const emailEl = document.getElementById('user-email-display');
      if (emailEl && res.user.email) emailEl.textContent = res.user.email;
    }
  } catch (e) {
    // apiRequest will redirect to /auth.html on 401, so we only land here on other errors
  }

  // Show tier badge
  try {
    const userMenuBtn = document.getElementById('user-menu-btn');
    if (userMenuBtn && tier) {
      let tierEl = document.getElementById('user-tier-badge');
      if (!tierEl) {
        tierEl = document.createElement('span');
        tierEl.id = 'user-tier-badge';
        tierEl.className = 'user-tier-badge';
        const emailEl = document.getElementById('user-email-display');
        if (emailEl && emailEl.parentNode) emailEl.parentNode.insertBefore(tierEl, emailEl.nextSibling);
        else userMenuBtn.appendChild(tierEl);
      }
      tierEl.textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
      tierEl.className = `user-tier-badge ${tier}`;
    }
  } catch (e) { /* ignore */ }

  console.debug('Resolved subscription_tier for UI:', tier);

  // Show/hide the free-trial notice: only for explicit "free" tier users
  try {
    const freeNotice = document.getElementById('free-trial-notice');
    if (freeNotice) {
      if (tier === 'free') freeNotice.style.display = '';
      else freeNotice.style.display = 'none';
    }
  } catch (e) { /* ignore */ }
  
  // Show create alert card for all users (free users can now create alerts)
  document.getElementById('create-alert-card').classList.remove('hidden');
  
  loadAlerts();
  // Reveal alerts card always — loadAlerts fills it
  document.getElementById('alerts-card').classList.remove('hidden');
  document.getElementById('notifications-card').classList.remove('hidden');
}

function init() {
  // Wire up buttons that exist in the DOM
  const safeOn = (sel, handler) => { const el = $(sel); if (el) el.addEventListener('click', handler); };
  const safeKey = (sel, handler) => { const el = $(sel); if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') handler(); }); };

  safeOn('#btn-logout',           handleLogout);
  safeOn('#btn-create-url-alert', createUrlAlert);
  safeOn('#btn-refresh',          loadAlerts);
  safeKey('#alert-search-url',    createUrlAlert);

  const alertSearchUrlEl = $('#alert-search-url');
  if (alertSearchUrlEl) {
    alertSearchUrlEl.addEventListener('paste', () => setTimeout(showSearchUrlPreview, 50));
    alertSearchUrlEl.addEventListener('blur', showSearchUrlPreview);
    alertSearchUrlEl.addEventListener('input', showSearchUrlPreview);
  }

  // (Listing-specific inputs removed from the UI)

  // User menu functionality
  const userMenuBtn = document.getElementById('user-menu-btn');
  const userDropdown = document.getElementById('user-dropdown');
  
  if (userMenuBtn && userDropdown) {
    userMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      userDropdown.classList.toggle('hidden');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!userMenuBtn.contains(e.target) && !userDropdown.contains(e.target)) {
        userDropdown.classList.add('hidden');
      }
    });
  }

  // Pagination controls (only wire if elements exist)
  const pageSizeEl = $('#page-size');
  if (pageSizeEl) pageSizeEl.onchange = (e) => {
    previewState.pageSize = parseInt(e.target.value, 10) || 20;
    fetchPreviewPage(previewState.page);
  };

  safeOn('#btn-prev-page', () => {
    if (previewState.page > 1) fetchPreviewPage(previewState.page - 1);
  });
  safeOn('#btn-next-page', () => {
    const maxPage = Math.ceil((previewState.total || 0) / previewState.pageSize) || 1;
    if (previewState.page < maxPage) fetchPreviewPage(previewState.page + 1);
  });
  safeOn('#btn-load-more', () => {
    const maxPage = Math.ceil((previewState.total || 0) / previewState.pageSize) || 1;
    if (previewState.page < maxPage) fetchPreviewPage(previewState.page + 1);
  });

  // Confirm modal
  safeOn('#confirm-cancel', () => closeConfirm(false));
  safeOn('#confirm-ok',     () => closeConfirm(true));

  // Alert-created confirmation modal controls
  safeOn('#btn-alert-created-notnow', () => { const m = $('#alert-created-modal'); if (m) m.classList.add('hidden'); });
  safeOn('#btn-upgrade-now', () => { window.location.href = '/billing'; });
  safeOn('#alert-created-close', () => { const m = $('#alert-created-modal'); if (m) m.classList.add('hidden'); });
  const _acBackdrop = $('#alert-created-backdrop'); if (_acBackdrop) _acBackdrop.addEventListener('click', () => { const m = $('#alert-created-modal'); if (m) m.classList.add('hidden'); });

  showLoggedInState();
  loadNotifications();
}

// confirm modal helper (returns Promise)
let _confirmResolve = null;
function confirmAction(message) {
  const modal = $('#confirm-modal');
  $('#confirm-body').textContent = message;
  modal.classList.remove('hidden');
  return new Promise((resolve) => { _confirmResolve = resolve; });
}
function closeConfirm(result) {
  const modal = $('#confirm-modal');
  modal.classList.add('hidden');
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}

function showAlertCreatedModal() {
  const modal = $('#alert-created-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
}

// Show the limit/upgrade modal to Free/Basic users when they try to add >1 search
function showLimitModal() {
  const modal = $('#limit-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  // wire backdrop/close (assign handlers to avoid stacking listeners)
  if ($('#limit-close')) $('#limit-close').onclick = () => modal.classList.add('hidden');
  if ($('#limit-backdrop')) $('#limit-backdrop').onclick = () => modal.classList.add('hidden');
  // upgrade button navigates to billing
  if ($('#btn-limit-upgrade')) $('#btn-limit-upgrade').onclick = () => { window.location.href = '/billing'; };
  if ($('#btn-limit-cancel')) $('#btn-limit-cancel').onclick = () => modal.classList.add('hidden');
}

// Returns true if user CAN create another search alert. If false, shows limit modal.
async function ensureCanCreateSearchAlert() {
  try {
    // Ask the server for current user + alert count — no local token parsing needed
    const [meRes, alertsRes] = await Promise.all([
      apiRequest('GET', '/api/auth/me'),
      apiRequest('GET', '/api/alerts'),
    ]);
    const tier = meRes?.user?.subscription_tier;
    if (tier === 'premium') return true;
    const alerts = alertsRes.alerts || [];
    if (tier === 'free') {
      const totalSearchCount = alerts.filter(a => a.alert_type === 'search').length;
      if (totalSearchCount >= 1) { showLimitModal(); return false; }
      return true;
    }
    const activeSearchCount = alerts.filter(a => a.alert_type === 'search' && a.is_active).length;
    if (activeSearchCount >= 1) { showLimitModal(); return false; }
    return true;
  } catch {
    return true; // fall back to server-side enforcement
  }
}

// Modal: fetch and render listing details + calendar
async function showListingModal(listingId) {
  const modal = $('#listing-modal');
  const body = $('#modal-body');
  modal.classList.remove('hidden');
  body.innerHTML = `<div id="modal-loader">Loading...</div>`;

  try {
    // Try live details first
    let res = await apiRequest('GET', `/api/listings/details/${listingId}`);
    let listing = res.listing;

    // fallback to DB-backed listing
    if (!listing) {
      res = await apiRequest('GET', `/api/listings/${listingId}`);
      listing = res.listing;
    }

    const photos = (listing.photos && listing.photos.length) ? listing.photos.map(p => (p.url || p)) : [];
    const mainPhoto = photos.length ? photos[0] : '';
    const photoHtml = photos.length ? `
      <div style="margin-bottom:12px">
        <div id="modal-main-photo" style="height:320px;border-radius:8px;overflow:hidden;margin-bottom:8px;background:#0f1113;display:flex;align-items:center;justify-content:center">
          ${mainPhoto ? `<img id="modal-main-img" src="${mainPhoto}" style="max-width:100%;max-height:100%;object-fit:cover"/>` : '<div style="color:var(--muted)">No photo</div>'}
        </div>
        <div class="modal-photos">${photos.slice(0,8).map((p,i)=>`<img src="${p}" data-index="${i}" loading="lazy" style="cursor:pointer"/>`).join('')}</div>
      </div>
    ` : '';

    const amenities = (listing.amenities || []).flatMap(g => (g.values || []).map(v => v.title || v));
    const amenHtml = amenities.length ? `<div class="amenities-list">${amenities.slice(0,20).map(a=>`<span class="amenity">${a}</span>`).join('')}</div>` : '';

    body.innerHTML = `
      <h3>${listing.name || 'Listing'}</h3>
      ${photoHtml}
      <div style="color:rgba(255,255,255,0.8);margin-bottom:8px">${listing.price ? (typeof listing.price === 'object' ? JSON.stringify(listing.price) : ('$'+listing.price)) : ''}</div>
      <div style="margin-bottom:12px">${listing.description || ''}</div>
      <div>${amenHtml}</div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button id="modal-check-calendar" class="secondary">Check calendar</button>
      </div>
      <pre id="modal-calendar-output" style="margin-top:12px;white-space:pre-wrap;background:rgba(255,255,255,0.02);padding:8px;border-radius:6px;display:none"></pre>
    `;

    // ("Save as alert" removed from listing modal)

    // Load price history if we have an alertId in context
    const activeAlertId = $('#listings-for-id')?.textContent?.trim();
    if (activeAlertId && listingId) {
      try {
        const ph = await apiRequest('GET', `/api/listings/alert/${activeAlertId}/listing/${listingId}/price-history`);
        if (ph.history && ph.history.length > 1) {
          const s = ph.summary;
          const direction = s.change < 0 ? '▼' : s.change > 0 ? '▲' : '→';
          const colour    = s.change < 0 ? '#48bb78' : s.change > 0 ? '#f56565' : '#a0aec0';
          const points    = ph.history.map(r => `${Number(r.price).toFixed(0)}`).join(' → ');
          const historyEl = document.createElement('div');
          historyEl.style.cssText = 'margin:12px 0;padding:10px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:13px';
          historyEl.innerHTML = `
            <div style="color:var(--muted);margin-bottom:6px">Price history (${s.dataPoints} data points)</div>
            <div style="color:${colour};font-size:15px;font-weight:600;margin-bottom:4px">
              ${direction} ${Math.abs(s.change).toFixed(0)} (${Math.abs(s.changePct)}%) since first seen
            </div>
            <div style="color:rgba(255,255,255,0.5);word-break:break-word">${points}</div>
            <div style="display:flex;gap:16px;margin-top:6px;color:var(--muted)">
              <span>Low: <strong style="color:var(--text)">${s.lowest}</strong></span>
              <span>High: <strong style="color:var(--text)">${s.highest}</strong></span>
              <span>Now: <strong style="color:var(--text)">${s.latest}</strong></span>
            </div>`;
          body.insertBefore(historyEl, body.querySelector('#modal-check-calendar').closest('div'));
        }
      } catch (e) { /* no history yet — silently skip */ }
    }

    $('#modal-check-calendar').onclick = async () => {
      const btn = $('#modal-check-calendar');
      setBtnLoading(btn, true, 'Checking...');
      try {
        const cal = await apiRequest('GET', `/api/listings/calendar/${listingId}`);
        $('#modal-calendar-output').style.display = 'block';
        $('#modal-calendar-output').textContent = JSON.stringify(cal.calendar || cal, null, 2);
      } catch (err) {
        showMessage(err.error || JSON.stringify(err), true);
      } finally {
        setBtnLoading(btn, false);
      }
    };
  } catch (err) {
    body.innerHTML = `<div style="color:var(--danger)">Failed to load details: ${err.error || err.message || JSON.stringify(err)}</div>`;
  }

  // thumbnail click -> update main photo
  document.querySelectorAll('.modal-photos img').forEach(img => {
    img.onclick = (e) => {
      const src = e.target.getAttribute('src');
      const main = $('#modal-main-img');
      if (main) main.src = src;
      // mark selected
      document.querySelectorAll('.modal-photos img').forEach(i => i.style.outline = '');
      e.target.style.outline = '2px solid rgba(255,255,255,0.12)';
    };
  });

  // keyboard: ESC to close, arrows to navigate photos
  const onKey = (ev) => {
    if (ev.key === 'Escape') { modal.classList.add('hidden'); document.removeEventListener('keydown', onKey); }
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      const imgs = Array.from(document.querySelectorAll('.modal-photos img'));
      if (!imgs.length) return;
      const main = $('#modal-main-img');
      const idx = imgs.findIndex(i => i.getAttribute('src') === (main && main.src));
      let next = idx;
      if (ev.key === 'ArrowRight') next = Math.min(imgs.length - 1, idx + 1);
      if (ev.key === 'ArrowLeft') next = Math.max(0, idx - 1);
      imgs[next].click();
    }
  };
  document.addEventListener('keydown', onKey);

  $('#modal-close').onclick = () => { modal.classList.add('hidden'); document.removeEventListener('keydown', onKey); };
  $('#modal-backdrop').onclick = () => { modal.classList.add('hidden'); document.removeEventListener('keydown', onKey); };
}

// Show modal with the exact search URL the user saved
function showSearchModal(url) {
  try {
    const modal = $('#search-modal');
    const display = $('#search-url-display');
    if (!modal || !display) return showMessage(url || 'No URL', true);
    display.textContent = url;
    modal.classList.remove('hidden');

    const onClose = () => { modal.classList.add('hidden'); document.removeEventListener('keydown', onKey); };
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };

    $('#search-modal-close').onclick = onClose;
    $('#search-backdrop').onclick = onClose;
    document.addEventListener('keydown', onKey);

    $('#search-open').onclick = () => { window.open(url, '_blank'); };
    $('#search-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        showMessage('Link copied to clipboard');
      } catch (e) {
        showMessage('Could not copy link', true);
      }
    };
  } catch (e) {
    showMessage('Failed to show search URL', true);
  }
}

async function previewSearch() {
  try {
    const location = $('#search-location').value;
    // dates are optional for preview — allow searching by location only
    const check_in = $('#search-check-in').value || null;
    const check_out = $('#search-check-out').value || null;
    const price_min = $('#price-min').value ? parseInt($('#price-min').value, 10) : null;
    const price_max = $('#price-max').value ? parseInt($('#price-max').value, 10) : null;
    const guests = $('#guests').value ? parseInt($('#guests').value, 10) : 1;

    if (!location) {
      return showMessage('Location is required to preview', true);
    }

    const listingsContainer = $('#listings-list');
    // show grid skeleton while fetching
    listingsContainer.innerHTML = '';
    const skGrid = document.createElement('div');
    skGrid.className = 'listing-grid';
    for (let i = 0; i < 6; i++) {
      const sk = document.createElement('div');
      sk.className = 'listing-card skeleton-card';
      sk.innerHTML = `<div class="skeleton skeleton-thumb"></div><div style="flex:1"><div class="skeleton-line" style="width:60%"></div><div class="skeleton-line" style="width:40%"></div></div>`;
      skGrid.appendChild(sk);
    }
    listingsContainer.appendChild(skGrid);

    // collect filter controls
    const premium = !!$('#filter-premium')?.checked;
    const premium_min_price = $('#filter-premium-min')?.value ? parseFloat($('#filter-premium-min').value) : null;
    const popular = !!$('#filter-popular')?.checked;
    const popular_min_reviews = $('#filter-popular-min')?.value ? parseInt($('#filter-popular-min').value, 10) : null;
    const superhost = !!$('#filter-superhost')?.checked;
    const only_saved = !!$('#filter-saved')?.checked;

    // if user picked an autocomplete suggestion, include its bounding box
    const params = {
      location, check_in, check_out, price_min, price_max, guests,
      premium, premium_min_price, popular, popular_min_reviews, superhost, only_saved
    };
    if (selectedLocation && selectedLocation.boundingbox) {
      // Nominatim boundingbox: [south, north, west, east]
      const [south, north, west, east] = selectedLocation.boundingbox.map(Number);
      params.ne_lat = north; params.ne_long = east; params.sw_lat = south; params.sw_long = west;
    }
    previewState.params = params;
    previewState.page = 1;
    previewState.pageSize = parseInt($('#page-size').value, 10) || 20;
    // persist immediately so a refresh doesn't lose this search
    savePreviewToLocalStorage();
    setBtnLoading($('#btn-preview-search'), true);
    try { await fetchPreviewPage(1); } finally { setBtnLoading($('#btn-preview-search'), false); }
    document.getElementById('listings-panel').classList.remove('hidden');
  } catch (err) {
    showMessage(err.error || JSON.stringify(err), true);
  }
}

document.addEventListener('DOMContentLoaded', init);
