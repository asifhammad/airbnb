import express from 'express';
import { query } from '../db/index.js';
import { authenticateToken } from '../middleware/auth.js';
import { searchAirbnb, getListingDetails, getCalendar } from '../workers/python-executor.js';
import axios from 'axios';

// Simple in-memory cache for geocoding results to avoid repeated calls to
// Nominatim during interactive use. TTL (seconds) configurable via
// process.env.GEO_CACHE_TTL_SECONDS (default 3600s).
const GEO_CACHE_TTL = parseInt(process.env.GEO_CACHE_TTL_SECONDS || '3600', 10);
const geocodeCache = new Map();

async function geocodeLocation(location) {
  if (!location) return null;
  const key = location.trim().toLowerCase();
  const cached = geocodeCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.bbox;

  const q = encodeURIComponent(location);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
  const geoRes = await axios.get(url, { headers: { 'User-Agent': 'airbnb-alerts-demo/1.0' }, timeout: 5000 });
  const hit = (geoRes.data && geoRes.data[0]) || null;
  if (!hit) return null;

  let bbox = null;
  if (hit.boundingbox && hit.boundingbox.length === 4) {
    const [south, north, west, east] = hit.boundingbox.map(Number);
    bbox = { ne_lat: north, ne_long: east, sw_lat: south, sw_long: west };
  } else if (hit.lat && hit.lon) {
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    const delta = 0.05;
    bbox = { ne_lat: lat + delta, ne_long: lon + delta, sw_lat: lat - delta, sw_long: lon - delta };
  }

  if (bbox) {
    geocodeCache.set(key, { bbox, expiresAt: now + GEO_CACHE_TTL * 1000 });
  }
  return bbox;
}

const router = express.Router();

// Get listings for a specific alert
router.get('/alert/:alertId', authenticateToken, async (req, res) => {
  try {
    const { alertId } = req.params;

    // Verify alert belongs to user
    const alertCheck = await query(
      'SELECT id FROM search_alerts WHERE id = $1 AND user_id = $2',
      [alertId, req.user.userId]
    );

    if (alertCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    // Get listings for this alert
    const result = await query(
      `SELECT l.*, sr.change_type, sr.detected_at, sr.notification_sent
       FROM listings l
       JOIN search_results sr ON l.listing_id = sr.listing_id
       WHERE sr.search_alert_id = $1
       ORDER BY sr.detected_at DESC
       LIMIT 50`,
      [alertId]
    );

    res.json({ listings: result.rows });
  } catch (error) {
    console.error('Get listings error:', error);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// NOTE: keep the specific/live endpoints above the generic DB lookup to
// avoid Express route collisions (/:listingId would match /details and /search).

// Get price history for a listing within an alert
router.get('/alert/:alertId/listing/:listingId/price-history', authenticateToken, async (req, res) => {
  try {
    const { alertId, listingId } = req.params;

    // Verify the alert belongs to this user
    const alertCheck = await query(
      'SELECT id FROM search_alerts WHERE id = $1 AND user_id = $2',
      [alertId, req.user.userId]
    );
    if (alertCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const result = await query(
      `SELECT price, recorded_at
       FROM listing_price_history
       WHERE listing_id = $1 AND search_alert_id = $2
       ORDER BY recorded_at ASC`,
      [listingId, alertId]
    );

    const history = result.rows;
    const prices  = history.map(r => Number(r.price));
    const first   = prices[0]   ?? null;
    const latest  = prices[prices.length - 1] ?? null;
    const lowest  = prices.length ? Math.min(...prices) : null;
    const highest = prices.length ? Math.max(...prices) : null;
    const change  = (first != null && latest != null) ? +(latest - first).toFixed(2) : null;
    const changePct = (first != null && first !== 0 && change != null)
      ? +((change / first) * 100).toFixed(1)
      : null;

    res.json({
      history,
      summary: { first, latest, lowest, highest, change, changePct, dataPoints: history.length },
    });
  } catch (error) {
    console.error('Price history error:', error);
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

// Get recent notifications for user
router.get('/notifications/recent', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT n.*, l.name as listing_name, l.url as listing_url,
              sa.location, sa.check_in, sa.check_out,
              COALESCE(sr.old_price, NULLIF(n.payload->'prices'->>'old_price', '')::numeric) AS old_price,
              COALESCE(sr.new_price, NULLIF(n.payload->'prices'->>'new_price', '')::numeric) AS new_price
       FROM notifications n
       LEFT JOIN listings l        ON n.listing_id       = l.listing_id
       LEFT JOIN search_alerts sa  ON n.search_alert_id  = sa.id
       LEFT JOIN search_results sr ON n.search_alert_id  = sr.search_alert_id
                                   AND n.listing_id      = sr.listing_id
       WHERE n.user_id = $1
       ORDER BY n.sent_at DESC
       LIMIT 20`,
      [req.user.userId]
    );

    res.json({ notifications: result.rows });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Search via Python scraper (returns live results, not persisted)
router.post('/search', authenticateToken, async (req, res) => {
  try {
    const params = req.body || {};

    // server-side pagination params
    const page = Math.max(1, parseInt(params.page || req.query.page || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize || req.query.pageSize || '20', 10) || 20));

    // If caller provided a human-readable location string, geocode it to a
    // bounding box that the Python scraper understands. Use cache when
    // possible.
    if (params.location && !(params.ne_lat && params.ne_long && params.sw_lat && params.sw_long)) {
      try {
        const bbox = await geocodeLocation(params.location);
        if (bbox) Object.assign(params, bbox);
      } catch (ge) {
        console.warn('Geocoding failed for location', params.location, ge.message);
      }
    }

  // sanitize params for the Python scraper (remove explicit nulls)
  const pyParams = Object.fromEntries(Object.entries(params).filter(([k, v]) => v !== null && typeof v !== 'undefined'));
  const results = await searchAirbnb(pyParams);
    let normalized = Array.isArray(results) ? results : (results.results || results.listings || []);

    // annotate saved status for current user (if any listings returned)
    const ids = normalized.map(r => r.id).filter(Boolean);
    let savedSet = new Set();
    if (ids.length > 0) {
      try {
        const savedRes = await query(
          `SELECT listing_id FROM search_alerts WHERE user_id = $1 AND alert_type = 'listing' AND listing_id = ANY($2)`,
          [req.user.userId, ids]
        );
        savedSet = new Set(savedRes.rows.map(r => String(r.listing_id)));
      } catch (e) {
        console.warn('Failed to lookup saved listings for user', e.message);
      }
    }

    // helper extractors
    const getRatingValue = (r) => {
      if (!r) return null;
      if (typeof r === 'number') return r;
      if (r.value) return Number(r.value);
      return null;
    };
    const getReviewsCount = (r) => {
      if (!r) return 0;
      if (typeof r === 'number') return r;
      if (r.reviewCount || r.reviewsCount) return Number(r.reviewCount || r.reviewsCount || 0);
      return Number(r) || 0;
    };
    const getPriceAmount = (p) => {
      if (p === null || typeof p === 'undefined') return null;
      if (typeof p === 'number') return p;
      // handle string prices like "$75" or "75.00"
      if (typeof p === 'string') {
        const n = parseFloat(p.replace(/[^0-9.\-]/g, ''));
        return Number.isFinite(n) ? n : null;
      }
      // common shapes: { unit: { amount } } or { amount } or { total: { amount } }
      if (p.unit && p.unit.amount) return Number(p.unit.amount);
      if (p.amount) return Number(p.amount);
      if (p.total && p.total.amount) return Number(p.total.amount);
      return null;
    };

    // Debugging: when DEBUG=1, print incoming params and a small sample so
    // it's easy to see why filters did/didn't match during preview.
    if (process.env.DEBUG === '1') {
      try {
        console.debug('Search request params:', params);
      } catch (e) { /* ignore */ }
    }

  // compute boolean flags for each listing
    normalized = normalized.map((r) => {
      const rating = getRatingValue(r.rating);
      const reviews = getReviewsCount(r.reviewsCount || r.rating);
      const price = getPriceAmount(r.price);
      return Object.assign({}, r, {
        _ratingValue: rating,
        _reviewsCount: reviews,
        _priceAmount: price,
        isSaved: savedSet.has(String(r.id)),
        isSuperhost: !!(r.hostIsSuperhost),
      });
    });

    // Apply explicit price range filters (defensive: also enforce on server-side
    // in case the Python scraper didn't apply them).
    const explicitMin = (typeof params.price_min !== 'undefined' && params.price_min !== null) ? parseFloat(params.price_min) : null;
    const explicitMax = (typeof params.price_max !== 'undefined' && params.price_max !== null) ? parseFloat(params.price_max) : null;
    if (explicitMin !== null) {
      normalized = normalized.filter(r => (r._priceAmount !== null) && (r._priceAmount >= explicitMin));
    }
    if (explicitMax !== null) {
      normalized = normalized.filter(r => (r._priceAmount !== null) && (r._priceAmount <= explicitMax));
    }

    if (process.env.DEBUG === '1') {
      try {
        const sample = normalized.slice(0, 6).map(x => ({ id: x.id, _priceAmount: getPriceAmount(x.price), _reviewsCount: getReviewsCount(x.reviewsCount || x.rating) }));
        console.debug('Normalized results sample (first 6):', sample);
      } catch (e) { /* ignore */ }
    }

    // apply filters (premium, popular, superhost, saved)
    const applyFilters = [];
    if (params.saved || params.only_saved) {
      normalized = normalized.filter(r => r.isSaved);
    }
    if (params.superhost) {
      normalized = normalized.filter(r => !!r.isSuperhost);
    }
    if (params.popular) {
      const minReviews = parseInt(params.popular_min_reviews || params.min_reviews || '50', 10);
      const minRating = parseFloat(params.popular_min_rating || params.min_rating || '4.7');
      normalized = normalized.filter(r => (r._reviewsCount >= minReviews) || (r._ratingValue >= minRating && r._reviewsCount >= 10));
    }
    if (params.premium) {
      const minPrice = parseFloat(params.premium_min_price || params.min_price || '200');
      normalized = normalized.filter(r => (r._priceAmount !== null) && (r._priceAmount >= minPrice));
    }

    const totalFiltered = normalized.length;
    const start = (page - 1) * pageSize;
    const pageResults = normalized.slice(start, start + pageSize);

    res.json({ results: pageResults, total: totalFiltered, page, pageSize });
  } catch (error) {
    console.error('Search API error:', error);
    res.status(500).json({ error: 'Search failed', details: error.message });
  }
});

// Validate listingId is purely numeric before it touches any process or DB query.
// Airbnb listing IDs are always integers; anything else is either a bug or an attack.
function validateListingId(req, res, next) {
  if (!/^\d{1,20}$/.test(req.params.listingId)) {
    return res.status(400).json({ error: 'Invalid listing ID' });
  }
  next();
}

// Get live listing details (from Python)
router.get('/details/:listingId', authenticateToken, validateListingId, async (req, res) => {
  try {
    const { listingId } = req.params;
    const details = await getListingDetails(listingId);
    res.json({ listing: details });
  } catch (error) {
    console.error('Get listing details error:', error);
    res.status(500).json({ error: 'Failed to fetch listing details', details: error.message });
  }
});

// Get calendar/availability (live)
router.get('/calendar/:listingId', authenticateToken, validateListingId, async (req, res) => {
  try {
    const { listingId } = req.params;
    const cal = await getCalendar(listingId);
    res.json({ calendar: cal });
  } catch (error) {
    console.error('Get calendar error:', error);
    res.status(500).json({ error: 'Failed to fetch calendar', details: error.message });
  }
});

// Generic DB-backed listing lookup (kept last so it doesn't shadow other routes)
router.get('/:listingId', authenticateToken, validateListingId, async (req, res) => {
  try {
    const { listingId } = req.params;

    const result = await query(
      'SELECT * FROM listings WHERE listing_id = $1',
      [listingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    res.json({ listing: result.rows[0] });
  } catch (error) {
    console.error('Get listing error:', error);
    res.status(500).json({ error: 'Failed to fetch listing' });
  }
});

export default router;
