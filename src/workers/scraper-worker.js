import scrapeQueue from './queue.js';
import { query } from '../db/index.js';
import { searchAirbnb } from './python-executor.js';
import logger from '../utils/logger.js';

const PREMIUM_NOTIFICATION_COOLDOWN_MINUTES = Math.max(
  0,
  Number.parseInt(process.env.PREMIUM_NOTIFICATION_COOLDOWN_MINUTES || '60', 10) || 60
);
const PREMIUM_MAX_EMAILS_PER_24H = Math.max(
  1,
  Number.parseInt(process.env.PREMIUM_MAX_EMAILS_PER_24H || '3', 10) || 3
);
const BASIC_NOTIFICATION_COOLDOWN_HOURS = 24;

// ─── Price extraction ────────────────────────────────────────────────────────
// The pyairbnb price object looks like:
// { unit: { qualifier: 'for 7 nights', amount: 418, discount: 367 }, ... }
// 'discount' is the actual price after weekly discounts — use that when present,
// fall back to 'amount', then total.amount, then a raw number.
function extractPrice(price) {
  if (price == null) return null;
  if (typeof price === 'number') return price;
  if (typeof price === 'string') {
    const n = parseFloat(price.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (typeof price === 'object') {
    const unit = price.unit || {};
    // 'discount' = price after weekly discount applied (what Airbnb shows on card)
    if (unit.discount != null) return Number(unit.discount);
    if (unit.amount  != null) return Number(unit.amount);
    if (price.total  && price.total.amount != null) return Number(price.total.amount);
  }
  return null;
}

// ─── Build listing URL ───────────────────────────────────────────────────────
function listingUrl(listing) {
  if (listing.url) return listing.url;
  if (listing.id)  return `https://www.airbnb.com/rooms/${listing.id}`;
  return null;
}

function listingCoverImage(listing) {
  const photos = listing?.photos;
  if (Array.isArray(photos) && photos.length > 0) {
    return photos[0]?.url || photos[0] || null;
  }
  if (listing?.picture_url) return listing.picture_url;
  if (listing?.image_url) return listing.image_url;
  if (listing?.thumbnail_url) return listing.thumbnail_url;
  return null;
}

function normalizeListingId(value) {
  if (value == null) return null;
  return String(value);
}

function buildListingUrlWithAlert(listingUrlValue, alert) {
  if (!listingUrlValue) return null;
  const normalizeDate = (value) => {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
    const str = String(value).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : null;
  };
  const checkIn = normalizeDate(alert?.check_in);
  const checkOut = normalizeDate(alert?.check_out);
  if (!checkIn && !checkOut) return listingUrlValue;
  try {
    const url = new URL(listingUrlValue);
    if (checkIn) {
      url.searchParams.set('check_in', checkIn);
      url.searchParams.set('checkin', checkIn);
    }
    if (checkOut) {
      url.searchParams.set('check_out', checkOut);
      url.searchParams.set('checkout', checkOut);
    }
    if (alert?.currency) url.searchParams.set('currency', String(alert.currency).toUpperCase());
    return url.toString();
  } catch (_) {
    return listingUrlValue;
  }
}

function resolveAlertLocation(alert) {
  const fallbackLocation = String(alert?.location || '').trim();
  if (fallbackLocation && !/^\/?rooms\//i.test(fallbackLocation)) {
    return fallbackLocation;
  }

  const searchUrl = String(alert?.search_url || '').trim();
  if (!searchUrl) return null;

  try {
    const url = new URL(searchUrl);
    const queryLocation = String(
      url.searchParams.get('query') || url.searchParams.get('location') || ''
    ).trim();
    if (queryLocation) return queryLocation;

    const match = (url.pathname || '').match(/^\/s\/([^/?#]+)/i);
    if (match?.[1]) {
      return decodeURIComponent(match[1]).replace(/--/g, ', ').replace(/-/g, ' ').trim() || null;
    }
  } catch (_) {
    // ignore invalid URLs and fall through
  }

  return null;
}

function inferCurrencyFromHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  const cc = host.split('.').pop() || '';
  const currencyMap = {
    ca: 'CAD',
    us: 'USD',
    fr: 'EUR',
    de: 'EUR',
    es: 'EUR',
    it: 'EUR',
    nl: 'EUR',
    be: 'EUR',
    at: 'EUR',
    pt: 'EUR',
    ie: 'EUR',
    gr: 'EUR',
    fi: 'EUR',
    no: 'NOK',
    se: 'SEK',
    dk: 'DKK',
    ch: 'CHF',
    pl: 'PLN',
    cz: 'CZK',
    hu: 'HUF',
    ro: 'RON',
    bg: 'BGN',
    uk: 'GBP',
    au: 'AUD',
    nz: 'NZD',
    jp: 'JPY',
    kr: 'KRW',
    sg: 'SGD',
    hk: 'HKD',
    my: 'MYR',
    th: 'THB',
    id: 'IDR',
    ph: 'PHP',
    vn: 'VND',
    tw: 'TWD',
    in: 'INR',
    br: 'BRL',
    mx: 'MXN',
    ar: 'ARS',
    cl: 'CLP',
    pe: 'PEN',
    co: 'COP',
    za: 'ZAR',
    tr: 'TRY',
    il: 'ILS',
    ae: 'AED',
  };
  return currencyMap[cc] || null;
}

function resolveAlertCurrency(alert, urlParams) {
  if (urlParams?.currency) return String(urlParams.currency).toUpperCase();
  if (alert?.currency) return String(alert.currency).toUpperCase();
  if (alert?.search_url) {
    try {
      const hostCurrency = inferCurrencyFromHost(new URL(alert.search_url).hostname);
      if (hostCurrency) return hostCurrency;
    } catch (_) {
      // ignore malformed URLs
    }
  }
  return 'USD';
}

function buildSearchParams(alert, urlParams) {
  return {
    search_url: alert.search_url || null,

    // Fallback fields (used when there is no search_url)
    check_in:  alert.check_in  || null,
    check_out: alert.check_out || null,
    ne_lat:    alert.ne_lat    || null,
    ne_long:   alert.ne_long   || null,
    sw_lat:    alert.sw_lat    || null,
    sw_long:   alert.sw_long   || null,
    price_min: alert.price_min || null,
    price_max: alert.price_max || (urlParams && urlParams.price_max ? Number(urlParams.price_max) : null),
    guests:    alert.guests    || (urlParams && (parseInt(urlParams.adults || 0) + parseInt(urlParams.children || 0))) || 1,
    amenities: alert.amenities || (urlParams && (urlParams['amenities[]'] || urlParams.amenities)) || [],
    free_cancellation: alert.free_cancellation || false,
    currency:  resolveAlertCurrency(alert, urlParams),
    proxy_url: process.env.PROXY_URL || '',

    // Extra filters forwarded to Python for fallback search_all() path
    min_beds:    alert.min_beds    || (urlParams && urlParams.min_beds ? parseInt(urlParams.min_beds) : null) || null,
    infants:     alert.infants     || (urlParams && urlParams.infants  ? parseInt(urlParams.infants)  : null) || null,
    instant_book:  (urlParams && (urlParams.ib === 'true' || urlParams.instant_book === 'true')) || !!alert.instant_book || false,
    guest_favorite:(urlParams && urlParams.guest_favorite === 'true') || !!alert.guest_favorite || false,
    monthly_search: !!((urlParams && (urlParams.monthly_start_date || urlParams.monthly_length)) && !(alert.check_in && alert.check_out)),
  };
}

async function buildFreshAvailabilitySet(searchFn, searchParams, alertId) {
  try {
    const freshListings = await searchFn(searchParams) || [];
    const availableIds = new Set(
      freshListings
        .map((listing) => normalizeListingId(listing?.id))
        .filter(Boolean)
    );
    logger.info(`Alert ${alertId}: pre-send validation matched ${availableIds.size} listings`);
    return availableIds;
  } catch (err) {
    logger.warn(`Alert ${alertId}: pre-send availability validation failed (${err.message || err})`);
    return new Set();
  }
}

// ─── Main search alert processor ─────────────────────────────────────────────
export async function runSearchAlert(alertId, opts = {}) {
  const {
    searchFn       = searchAirbnb,
    dbQuery        = query,
  } = opts;

  logger.info(`Processing search alert ${alertId}`);

  // Load alert
  const alertResult = await dbQuery(
    `SELECT * FROM search_alerts WHERE id = $1 AND is_active = true`,
    [alertId]
  );
  if (alertResult.rows.length === 0) {
    logger.warn(`Alert ${alertId} not found or inactive`);
    return { status: 'skipped', reason: 'Alert not found or inactive' };
  }
  const alert = alertResult.rows[0];

  // Parse stored url_params
  let urlParams = null;
  try {
    if (alert.url_params) {
      urlParams = typeof alert.url_params === 'string'
        ? JSON.parse(alert.url_params)
        : alert.url_params;
    }
  } catch (_) { urlParams = null; }

  // ── Build search params for Python ─────────────────────────────────────────
  // Always prefer search_url — our new airbnb_search.py uses it directly and
  // produces results that exactly match the Airbnb UI.
  const searchParams = buildSearchParams(alert, urlParams);

  // Run scraper
  let currentListings = [];
  try {
    currentListings = await searchFn(searchParams) || [];
  } catch (err) {
    logger.error(`Scraper failed for alert ${alertId}:`, err);
    return { status: 'error', error: err.message };
  }

  logger.info(`Alert ${alertId}: scraper returned ${currentListings.length} listings`);

  if (currentListings.length === 0) {
    logger.warn(`Alert ${alertId}: zero results — possible API change or filter mismatch`);
    await dbQuery(`UPDATE search_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = $1`, [alertId]);
    return { status: 'success', alertId, totalListings: 0, newListings: 0, priceDrops: 0, freedUp: 0 };
  }

  // ── Load what we already know about this alert ──────────────────────────────
  // known_listing_ids = listings we've seen before for this alert
  // We also load last known price per listing so we can detect drops.
  // Read last known price from price history (the only append-only source).
  // Using listings.price would give us the already-overwritten current value;
  // using search_results.old_price loses the original baseline on every upsert.
  // DISTINCT ON picks the single most-recent row per listing for this alert.
  const knownResult = await dbQuery(
    `WITH known_ids AS (
       SELECT listing_id
       FROM search_results
       WHERE search_alert_id = $1
       UNION
       SELECT listing_id
       FROM listing_price_history
       WHERE search_alert_id = $1
     )
     SELECT
       k.listing_id,
       COALESCE(
         (
           SELECT lph.price
           FROM listing_price_history lph
           WHERE lph.search_alert_id = $1
             AND lph.listing_id = k.listing_id
           ORDER BY lph.recorded_at DESC
           LIMIT 1
         ),
         (
           SELECT sr.new_price
           FROM search_results sr
           WHERE sr.search_alert_id = $1
             AND sr.listing_id = k.listing_id
           ORDER BY sr.detected_at DESC
           LIMIT 1
         ),
         (
           SELECT l.price
           FROM listings l
           WHERE l.listing_id = k.listing_id
         )
       ) AS last_price
     FROM known_ids k`,
    [alertId]
  );
  const knownListings = new Map(
    knownResult.rows.map((r) => {
      const parsed = r.last_price == null ? null : Number(r.last_price);
      return [r.listing_id, Number.isFinite(parsed) ? parsed : null];
    })
  );
  const isBootstrapRun = knownListings.size === 0;
  let bootstrapNewCount = 0;

  // ── Process each listing returned by the scraper ───────────────────────────
  const newListings       = [];
  const priceDropListings = [];
  const freedUpListings   = [];

  for (const listing of currentListings) {
    const id       = listing.id;
    const price    = extractPrice(listing.price);
    const url      = listingUrl(listing);

    if (!id) continue;

    // Upsert into listings cache
    await dbQuery(
      `INSERT INTO listings
         (listing_id, url, name, price, currency, rating, num_reviews,
          room_type, guests, beds, bedrooms, address, lat, lng,
          host_id, host_name, photos, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,CURRENT_TIMESTAMP)
       ON CONFLICT (listing_id) DO UPDATE SET
         price      = EXCLUDED.price,
         rating     = EXCLUDED.rating,
         num_reviews= EXCLUDED.num_reviews,
         last_updated = CURRENT_TIMESTAMP`,
      [
        id, url, listing.name, price,
        listing.currency || 'USD',
        listing.rating,
        listing.reviewsCount || 0,
        listing.roomType,
        listing.guests,
        listing.beds,
        listing.bedrooms,
        listing.address,
        listing.lat,
        listing.lng,
        listing.hostId,
        listing.hostName,
        JSON.stringify(listing.photos || []),
      ]
    );

    // Append to price history only when price changes from last recorded value
    if (price != null) {
      await dbQuery(
        `INSERT INTO listing_price_history (listing_id, search_alert_id, price)
         SELECT $1::text, $2::int, $3::numeric
         WHERE NOT EXISTS (
           SELECT 1 FROM listing_price_history
           WHERE listing_id = $1::text AND search_alert_id = $2::int
             AND price = $3::numeric
             AND recorded_at = (
               SELECT MAX(recorded_at) FROM listing_price_history
               WHERE listing_id = $1::text AND search_alert_id = $2::int
             )
         )`,
        [id, alertId, price]
      );
    }

    const wasKnown   = knownListings.has(id);
    const lastPrice  = knownListings.get(id) ?? null;

    if (!wasKnown) {
      // ── NEW LISTING ──────────────────────────────────────────────────────
      await upsertSearchResult(dbQuery, alertId, id, 'new', null, price);
      if (isBootstrapRun) {
        bootstrapNewCount += 1;
      } else {
        newListings.push({ ...listing, price, url });
      }

    } else {
      // ── EXISTING LISTING — check for price drop or freed-up ────────────

      // Price drop: current price is meaningfully lower than what we last stored.
      // Require a minimum absolute drop of $5 AND at least 3% to filter out
      // rounding noise and trivial Airbnb display fluctuations.
      const DROP_MIN_ABS = 5;   // dollars
      const DROP_MIN_PCT = 0.03; // 3%
      const drop = (price != null && lastPrice != null) ? lastPrice - price : 0;
      if (price != null && lastPrice != null && price < lastPrice &&
          drop >= DROP_MIN_ABS && drop / lastPrice >= DROP_MIN_PCT) {
        // Only alert if we haven't already notified at this price point
        const alreadyNotified = await dbQuery(
          `SELECT 1 FROM notifications
           WHERE search_alert_id = $1 AND listing_id = $2
             AND notification_type = 'price_drop'
             AND sent_at > NOW() - INTERVAL '24 hours'
           LIMIT 1`,
          [alertId, id]
        );
        if (alreadyNotified.rows.length === 0) {
          await upsertSearchResult(dbQuery, alertId, id, 'price_drop', lastPrice, price);
          // Fetch history to include in email
          const histResult = await dbQuery(
            `SELECT price, recorded_at FROM listing_price_history
             WHERE listing_id = $1 AND search_alert_id = $2
             ORDER BY recorded_at ASC`,
            [id, alertId]
          );
          priceDropListings.push({ ...listing, price, url, oldPrice: lastPrice, newPrice: price, priceHistory: histResult.rows });
        }
      }

      // iCal validation removed; "freed up" signals are disabled.
    }
  }

  // ── Mark last checked ──────────────────────────────────────────────────────
  await dbQuery(
    `UPDATE search_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = $1`,
    [alertId]
  );

  if (isBootstrapRun && bootstrapNewCount > 0) {
    logger.info(
      `Alert ${alertId} bootstrap baseline created (${bootstrapNewCount} listings); notifications suppressed on first run`
    );
  }

  // ── Queue email notifications ──────────────────────────────────────────────
  const userResult = await dbQuery(
    `SELECT u.subscription_tier FROM users u
     JOIN search_alerts sa ON sa.user_id = u.id
     WHERE sa.id = $1`,
    [alertId]
  );
  const subscriptionTier = userResult.rows[0]?.subscription_tier;

  if (subscriptionTier) {
    const hasChanges = newListings.length > 0 || priceDropListings.length > 0 || freedUpListings.length > 0;
    if (hasChanges) {
      const lastEmailCheck = await dbQuery(
        `SELECT last_notified FROM search_alerts WHERE id = $1`,
        [alertId]
      );
      const lastNotified = lastEmailCheck.rows[0]?.last_notified;
      const msSinceLastNotified = lastNotified ? (new Date() - new Date(lastNotified)) : Number.POSITIVE_INFINITY;

      const isPremium = subscriptionTier === 'premium';
      const cooldownMs = isPremium
        ? PREMIUM_NOTIFICATION_COOLDOWN_MINUTES * 60 * 1000
        : BASIC_NOTIFICATION_COOLDOWN_HOURS * 60 * 60 * 1000;
      const hasQueuedRecently = msSinceLastNotified < cooldownMs;

      if (hasQueuedRecently) {
        logger.info(
          `Alert ${alertId} (${subscriptionTier} tier): skipping queue — already queued within last ${isPremium ? PREMIUM_NOTIFICATION_COOLDOWN_MINUTES + ' minutes' : '24 hours'}`
        );
      } else {
        let remainingQuota = 1; // basic/free hard cap
        if (isPremium) {
          const sentCountRes = await dbQuery(
            `SELECT COUNT(*)::int AS sent_count
             FROM notifications
             WHERE search_alert_id = $1
               AND sent_at > NOW() - INTERVAL '24 hours'`,
            [alertId]
          );
          const sentCount24h = Number(sentCountRes.rows[0]?.sent_count || 0);
          remainingQuota = Math.max(0, PREMIUM_MAX_EMAILS_PER_24H - sentCount24h);
        }

        if (remainingQuota <= 0) {
          logger.info(
            `Alert ${alertId} (${subscriptionTier} tier): skipping queue — reached quota in last 24 hours`
          );
        } else {
          // Priority: price drop > availability > new listing.
          // Before queueing anything, run a fresh search and only queue listings
          // still present for the exact alert query (do not rely on iCal here).
          const availableNow = await buildFreshAvailabilitySet(searchFn, searchParams, alertId);
          const preValidatedBatches = [
            { listings: priceDropListings, emailType: 'price_drop',   notifType: 'price_drop' },
            { listings: newListings,       emailType: 'new',          notifType: 'new_listing' },
          ].map((batch) => ({
            ...batch,
            listings: batch.listings.filter((l) => availableNow.has(normalizeListingId(l?.id))),
          }));

          const filteredOutCount =
            (priceDropListings.length + freedUpListings.length + newListings.length) -
            preValidatedBatches.reduce((sum, b) => sum + b.listings.length, 0);
          if (filteredOutCount > 0) {
            logger.info(
              `Alert ${alertId}: pre-send validation filtered ${filteredOutCount} listing(s) no longer matching alert availability`
            );
          }

          let queuedTotal = 0;
          for (const batch of preValidatedBatches) {
            if (remainingQuota <= 0) break;
            if (!batch.listings.length) continue;
            const toQueue = batch.listings.slice(0, remainingQuota);
            const queued = await sendAlerts(dbQuery, alert, alertId, toQueue, batch.emailType, batch.notifType);
            queuedTotal += queued;
            remainingQuota -= queued;
          }

          logger.info(
            `Alert ${alertId} (${subscriptionTier} tier): queued ${queuedTotal} notification(s) this run`
          );
        }
      }
    }
  }

  logger.info(
    `Alert ${alertId} done — new:${newListings.length} drops:${priceDropListings.length} freed:${freedUpListings.length}`
  );

  return {
    status: 'success',
    alertId,
    totalListings:  currentListings.length,
    newListings:    newListings.length,
    priceDrops:     priceDropListings.length,
    freedUp:        freedUpListings.length,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsertSearchResult(dbQuery, alertId, listingId, changeType, oldPrice, newPrice) {
  await dbQuery(
    `INSERT INTO search_results
       (search_alert_id, listing_id, change_type, old_price, new_price, detected_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (search_alert_id, listing_id) DO UPDATE SET
       change_type  = EXCLUDED.change_type,
       old_price    = EXCLUDED.old_price,
       new_price    = EXCLUDED.new_price,
       detected_at  = CURRENT_TIMESTAMP`,
    [alertId, listingId, changeType, oldPrice ?? null, newPrice ?? null]
  );
}

async function sendAlerts(dbQuery, alert, alertId, listings, emailType, notifType) {
  if (!listings.length) return 0;
  // Queue notification rows for Dreamlit to send; email_sent=false means pending.
  let queuedCount = 0;
  const resolvedLocation = resolveAlertLocation(alert);
  const normalizeDate = (value) => {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
    const str = String(value).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : null;
  };
  for (const l of listings) {
    if (!l) {
      logger.warn(`Alert ${alertId}: skipping notification with empty listing payload`);
      continue;
    }
    const rawListingUrl = l.url ?? listingUrl(l);
    const listingUrlWithDates = buildListingUrlWithAlert(rawListingUrl, alert);
    const listingName = l.name ?? null;
    const listingImage = listingCoverImage(l);
    if (!listingUrlWithDates || !listingName) {
      logger.warn(
        `Alert ${alertId}: skipping notification missing listing data (id=${l.id ?? 'n/a'}, url=${Boolean(listingUrlWithDates)}, name=${Boolean(listingName)})`
      );
      continue;
    }
    const payload = {
      email_type: emailType,
      listing_url: listingUrlWithDates,
      listing_name: listingName,
      listing_image_url: listingImage,
      listing_id: l.id ?? null,
      listing: {
        id: l.id ?? null,
        name: listingName,
        url: listingUrlWithDates,
        image_url: listingImage,
        address: l.address ?? null,
        rating: l.rating ?? null,
      },
      prices: {
        old_price: l.oldPrice ?? null,
        new_price: l.newPrice ?? (l.price ?? null),
        current_price: l.price ?? null,
      },
      alert: {
        location: resolvedLocation,
        check_in: normalizeDate(alert.check_in),
        check_out: normalizeDate(alert.check_out),
        currency: alert.currency ?? null,
        guests: alert.guests ?? null,
        price_min: alert.price_min ?? null,
        price_max: alert.price_max ?? null,
      },
    };
    await dbQuery(
      `INSERT INTO notifications
         (user_id, search_alert_id, listing_id, notification_type, email_sent, payload)
       VALUES ($1::int, $2::int, $3::text, $4::text, false, $5::jsonb)`,
      [alert.user_id, alertId, l.id, notifType, JSON.stringify(payload)]
    );
    queuedCount += 1;
  }
  if (queuedCount > 0) {
    await dbQuery(
      `UPDATE search_alerts SET
         last_notified      = CURRENT_TIMESTAMP,
         notification_count = notification_count + $2
       WHERE id = $1`,
      [alertId, queuedCount]
    );
  }
  return queuedCount;
}

// ─── Wire up queue ────────────────────────────────────────────────────────────
function registerQueueProcessors() {
  scrapeQueue.process('search', async (job) => {
    return await runSearchAlert(job.data.alertId);
  });

// ─── Listing-specific alert (iCal availability tracking) ─────────────────────
  scrapeQueue.process('listing', async (job) => {
  const { alertId } = job.data;
  logger.info(`Listing alert ${alertId} skipped (iCal-based listing alerts disabled)`);
  await query(`UPDATE search_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = $1`, [alertId]);
  return { status: 'skipped', alertId, reason: 'iCal-based listing alerts disabled' };
  });

  logger.info('🔄 Worker started');
}

if (process.env.WORKER_AUTOSTART !== 'false') {
  registerQueueProcessors();
}

export default scrapeQueue;
