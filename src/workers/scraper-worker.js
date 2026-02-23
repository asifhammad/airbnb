import scrapeQueue from './queue.js';
import { query } from '../db/index.js';
import { searchAirbnb } from './python-executor.js';
import { checkICalAvailability } from '../services/ical.js';
import logger from '../utils/logger.js';

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

// ─── Main search alert processor ─────────────────────────────────────────────
export async function runSearchAlert(alertId, opts = {}) {
  const {
    searchFn       = searchAirbnb,
    checkICalFn    = checkICalAvailability,
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
  const searchParams = {
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
    currency:  (urlParams && urlParams.currency) || 'USD',
    proxy_url: process.env.PROXY_URL || '',

    // Extra filters forwarded to Python for the fallback search_all() path
    min_beds:    alert.min_beds    || (urlParams && urlParams.min_beds ? parseInt(urlParams.min_beds) : null) || null,
    infants:     alert.infants     || (urlParams && urlParams.infants  ? parseInt(urlParams.infants)  : null) || null,
    instant_book:  (urlParams && (urlParams.ib === 'true' || urlParams.instant_book === 'true')) || !!alert.instant_book || false,
    guest_favorite:(urlParams && urlParams.guest_favorite === 'true') || !!alert.guest_favorite || false,
    monthly_search: !!((urlParams && (urlParams.monthly_start_date || urlParams.monthly_length)) && !(alert.check_in && alert.check_out)),
  };

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
      // For date-specific searches, verify availability via iCal before
      // alerting — the search API returns all listings matching the filters
      // but doesn't guarantee the exact dates are open.
      if (alert.check_in && alert.check_out) {
        let available = false;
        try {
          available = await checkICalFn(id, alert.check_in, alert.check_out);
        } catch (err) {
          logger.warn(`iCal check failed for new listing ${id}: ${err.message}`);
          available = true; // optimistic — better to over-notify than miss
        }
        if (!available) {
          logger.debug(`New listing ${id} skipped — not available for requested dates`);
          // Still record it so we can track it for "freed up" later
          await upsertSearchResult(dbQuery, alertId, id, 'new', null, price);
          continue;
        }
      }

      await upsertSearchResult(dbQuery, alertId, id, 'new', null, price);
      newListings.push({ ...listing, price, url });

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

      // Freed up: listing was previously unavailable for these dates but now is
      if (alert.check_in && alert.check_out) {
        try {
          const nowAvailable = await checkICalFn(id, alert.check_in, alert.check_out);
          if (nowAvailable) {
            // Only fire if we haven't sent a freed-up alert for this listing recently
            const alreadyNotified = await dbQuery(
              `SELECT 1 FROM notifications
               WHERE search_alert_id = $1 AND listing_id = $2
                 AND notification_type = 'availability_change'
                 AND sent_at > NOW() - INTERVAL '24 hours'
               LIMIT 1`,
              [alertId, id]
            );
            if (alreadyNotified.rows.length === 0) {
              await upsertSearchResult(dbQuery, alertId, id, 'freed_up', null, price);
              freedUpListings.push({ ...listing, price, url });
            }
          }
        } catch (err) {
          logger.warn(`iCal check failed for existing listing ${id}: ${err.message}`);
        }
      }
    }
  }

  // ── Mark last checked ──────────────────────────────────────────────────────
  await dbQuery(
    `UPDATE search_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = $1`,
    [alertId]
  );

  // ── Send emails ────────────────────────────────────────────────────────────
  const userResult = await dbQuery(
    `SELECT u.subscription_tier FROM users u
     JOIN search_alerts sa ON sa.user_id = u.id
     WHERE sa.id = $1`,
    [alertId]
  );
  const subscriptionTier = userResult.rows[0]?.subscription_tier;

  if (subscriptionTier) {
    // Premium tier: email for all detected changes as they happen.
    // Basic tier: email for all changes but max 1 email per 24 hours.
    if (subscriptionTier === 'premium') {
      // Premium: queue all change types as they happen
      await sendAlerts(dbQuery, alert, alertId, newListings,       'new',         'new_listing');
      await sendAlerts(dbQuery, alert, alertId, priceDropListings, 'price_drop',  'price_drop');
      await sendAlerts(dbQuery, alert, alertId, freedUpListings,   'availability','availability_change');
    } else {
      // Basic: queue all changes, but max 1 queued email bundle per 24 hours
      const lastEmailCheck = await dbQuery(
        `SELECT last_notified FROM search_alerts WHERE id = $1`,
        [alertId]
      );
      
      const lastNotified = lastEmailCheck.rows[0]?.last_notified;
      const hasEmailedRecently = lastNotified && (new Date() - new Date(lastNotified)) < 24 * 60 * 60 * 1000;
      
      if (!hasEmailedRecently) {
        // Queue notifications only if we haven't queued one in the last 24 hours
        const hasChanges = newListings.length > 0 || priceDropListings.length > 0 || freedUpListings.length > 0;
        
        if (hasChanges) {
          await sendAlerts(dbQuery, alert, alertId, newListings,       'new',         'new_listing');
          await sendAlerts(dbQuery, alert, alertId, priceDropListings, 'price_drop',  'price_drop');
          await sendAlerts(dbQuery, alert, alertId, freedUpListings,   'availability','availability_change');
        }
      } else {
        logger.info(`Alert ${alertId} (basic tier): skipping queue — already queued within last 24 hours`);
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
  if (!listings.length) return;
  // Queue notification rows for Dreamlit to send; email_sent=false means pending.
  for (const l of listings) {
    const payload = {
      email_type: emailType,
      listing: {
        id: l.id ?? null,
        name: l.name ?? null,
        url: l.url ?? null,
        address: l.address ?? null,
        rating: l.rating ?? null,
      },
      prices: {
        old_price: l.oldPrice ?? null,
        new_price: l.newPrice ?? (l.price ?? null),
        current_price: l.price ?? null,
      },
      alert: {
        location: alert.location ?? null,
        check_in: alert.check_in ?? null,
        check_out: alert.check_out ?? null,
        guests: alert.guests ?? null,
        price_min: alert.price_min ?? null,
        price_max: alert.price_max ?? null,
      },
    };
    await dbQuery(
      `INSERT INTO notifications
         (user_id, search_alert_id, listing_id, notification_type, email_sent, payload)
       SELECT user_id, $1::int, $2::text, $3::text, false, $4::jsonb FROM search_alerts WHERE id = $1::int`,
      [alertId, l.id, notifType, JSON.stringify(payload)]
    );
  }
  await dbQuery(
    `UPDATE search_alerts SET
       last_notified      = CURRENT_TIMESTAMP,
       notification_count = notification_count + $2
     WHERE id = $1`,
    [alertId, listings.length]
  );
}

// ─── Wire up queue ────────────────────────────────────────────────────────────
function registerQueueProcessors() {
  scrapeQueue.process('search', async (job) => {
    return await runSearchAlert(job.data.alertId);
  });

// ─── Listing-specific alert (iCal availability tracking) ─────────────────────
  scrapeQueue.process('listing', async (job) => {
  const { alertId } = job.data;
  logger.info(`Processing listing alert ${alertId}`);

  const alertResult = await query(
    `SELECT * FROM search_alerts WHERE id = $1 AND is_active = true AND alert_type = 'listing'`,
    [alertId]
  );
  if (alertResult.rows.length === 0) {
    return { status: 'skipped', reason: 'Alert not found or inactive' };
  }
  const alert = alertResult.rows[0];

  let isAvailable = false;
  try {
    isAvailable = await checkICalAvailability(alert.listing_id, alert.check_in, alert.check_out);
  } catch (err) {
    logger.warn(`iCal check failed for listing alert ${alertId}: ${err.message}`);
  }

  if (isAvailable) {
    const alreadyNotified = await query(
      `SELECT 1 FROM notifications
       WHERE search_alert_id = $1 AND notification_type = 'availability_change'
         AND sent_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [alertId]
    );

    if (alreadyNotified.rows.length === 0) {
      const payload = {
        email_type: 'availability',
        listing: {
          id: alert.listing_id ?? null,
          name: 'Your tracked listing is now available!',
          url: alert.listing_url ?? null,
        },
        alert: {
          check_in: alert.check_in ?? null,
          check_out: alert.check_out ?? null,
        },
      };
      await query(
        `INSERT INTO notifications (user_id, search_alert_id, listing_id, notification_type, email_sent, payload)
         VALUES ($1, $2, $3, 'availability_change', false, $4::jsonb)`,
        [alert.user_id, alertId, alert.listing_id, JSON.stringify(payload)]
      );
      await query(
        `UPDATE search_alerts SET last_notified = CURRENT_TIMESTAMP, notification_count = notification_count + 1 WHERE id = $1`,
        [alertId]
      );
    }
  }

  await query(`UPDATE search_alerts SET last_checked = CURRENT_TIMESTAMP WHERE id = $1`, [alertId]);
  return { status: 'success', alertId, isAvailable };
  });

  logger.info('🔄 Worker started');
}

if (process.env.WORKER_AUTOSTART !== 'false') {
  registerQueueProcessors();
}

export default scrapeQueue;
