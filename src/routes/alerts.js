import express from 'express';
import { query } from '../db/index.js';
import { authenticateToken, checkSubscription } from '../middleware/auth.js';
import { addSearchJob, addListingJob } from '../workers/queue.js';
import parseListingUrl from '../utils/parseListingUrl.js';
import { getListingDetails } from '../workers/python-executor.js';
import parseSearchUrl from '../utils/parseSearchUrl.js';
import { resolveCurrentSubscriptionTier } from '../utils/subscriptionTier.js';
import isAirbnbHostname from '../utils/isAirbnbHostname.js';

const router = express.Router();
const FREE_TRIAL_DURATION_DAYS = 7;

async function isWithinFreeTrialWindow(userId) {
  const result = await query(
    `SELECT created_at
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  const createdAt = result.rows[0]?.created_at;
  if (!createdAt) return false;
  const trialEnd = new Date(createdAt).getTime() + FREE_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() <= trialEnd;
}

async function resolveRequestSubscriptionTier(req) {
  const subscriptionTier = await resolveCurrentSubscriptionTier({
    userId: req.user?.userId,
    tokenTier: req.user?.subscription_tier,
    dbQuery: query
  });
  req.user.subscription_tier = subscriptionTier;
  return subscriptionTier;
}

// Get all alerts for user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, alert_type, location, check_in, check_out, 
              price_min, price_max, guests, listing_id, listing_url,
              search_url, url_params,
              is_active, last_checked, last_notified,
              (
                SELECT COUNT(*)
                FROM notifications n
                WHERE n.search_alert_id = sa.id
                  AND n.user_id = sa.user_id
              ) AS notification_count,
              created_at, is_free_trial, expires_at
       FROM search_alerts sa
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [req.user.userId]
    );

    res.json({ alerts: result.rows });
  } catch (error) {
    // Backward-compatible fallback for older DB schemas missing optional columns.
    if (error?.code === '42703') {
      try {
        const fallback = await query(
          `SELECT id, alert_type, location, check_in, check_out,
                  price_min, price_max, guests, listing_id, listing_url,
                  is_active, last_checked,
                  NULL::timestamp AS last_notified,
                  0::integer AS notification_count,
                  created_at, is_free_trial, expires_at,
                  NULL::text AS search_url,
                  NULL::jsonb AS url_params
           FROM search_alerts
           WHERE user_id = $1
           ORDER BY created_at DESC`,
          [req.user.userId]
        );
        return res.json({ alerts: fallback.rows });
      } catch (fallbackError) {
        console.error('Get alerts fallback error:', fallbackError);
      }
    }
    console.error('Get alerts error:', error);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// Create new search alert
router.post('/search', authenticateToken, async (req, res) => {
  try {
    const subscriptionTier = await resolveRequestSubscriptionTier(req);
    const {
      location,
      check_in,
      check_out,
      ne_lat,
      ne_long,
      sw_lat,
      sw_long,
      price_min,
      price_max,
      guests,
      place_type,
      amenities,
      free_cancellation
    } = req.body;

    // Validate required fields
    if (!location || !check_in || !check_out) {
      return res.status(400).json({ 
        error: 'Location, check-in, and check-out dates are required' 
      });
    }

    const withinTrialWindow = subscriptionTier === 'free'
      ? await isWithinFreeTrialWindow(req.user.userId)
      : false;

    // Check if user already has an active free trial alert and count current alerts in one query
    const alertCheck = await query(
      `SELECT 
         COUNT(*) FILTER (WHERE is_free_trial = true AND is_active = true AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)) as free_trial_count,
         COUNT(*) FILTER (WHERE is_active = true AND (is_free_trial = false OR expires_at IS NULL OR expires_at <= CURRENT_TIMESTAMP)) as paid_alert_count,
         COUNT(*) FILTER (WHERE is_active = true) as active_alert_count
       FROM search_alerts 
       WHERE user_id = $1`,
      [req.user.userId]
    );
    
    const maxAlerts = subscriptionTier === 'premium' ? 10 : 1;
    const isFreeTrial = subscriptionTier === 'basic' || (subscriptionTier === 'free' && withinTrialWindow);
    const expiresAt = isFreeTrial
      ? new Date(Date.now() + FREE_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000)
      : null;

    const freeTrialCount = parseInt(alertCheck.rows[0].free_trial_count);
    const currentAlerts = parseInt(alertCheck.rows[0].paid_alert_count);
    const activeAlerts = parseInt(alertCheck.rows[0].active_alert_count);

    // Check limits
    if (subscriptionTier === 'free' && activeAlerts >= 1) {
      return res.status(403).json({
        error: 'Free tier allows one active alert at a time. Deactivate your existing alert to create another.',
        upgrade_required: true
      });
    }

    if (isFreeTrial && freeTrialCount > 0) {
      return res.status(403).json({ 
        error: 'Free users can only have one active alert at a time. Please upgrade to create more alerts.',
        upgrade_required: true
      });
    }

    if (!isFreeTrial && currentAlerts >= maxAlerts) {
      return res.status(403).json({ 
        error: `Maximum ${maxAlerts} active alerts for ${req.user.subscription_tier} tier`,
        upgrade_required: true
      });
    }

    // Create alert
    const result = await query(
      `INSERT INTO search_alerts 
       (user_id, alert_type, location, check_in, check_out, 
        ne_lat, ne_long, sw_lat, sw_long, price_min, price_max, 
        guests, place_type, amenities, free_cancellation, is_free_trial, expires_at)
       VALUES ($1, 'search', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        req.user.userId, location, check_in, check_out,
        ne_lat, ne_long, sw_lat, sw_long,
        price_min, price_max, guests, place_type,
        JSON.stringify(amenities || []), free_cancellation, isFreeTrial, expiresAt
      ]
    );

    // Add to scraping queue (non-blocking)
    addSearchJob(result.rows[0].id).catch(err => {
      console.error('Failed to queue search job:', err);
    });

    const message = isFreeTrial 
      ? `Free alert created! This alert will expire in ${FREE_TRIAL_DURATION_DAYS} days. Upgrade to create permanent alerts.`
      : 'Alert created successfully';

    res.status(201).json({
      message,
      alert: result.rows[0],
      is_free_trial: isFreeTrial,
      expires_at: expiresAt
    });
  } catch (error) {
    console.error('Create alert error:', error);
    res.status(500).json({ error: 'Failed to create alert' });
  }
});

// Create new URL-based search alert
router.post('/url', authenticateToken, async (req, res) => {
  try {
    const subscriptionTier = await resolveRequestSubscriptionTier(req);
    const { search_url } = req.body;

    if (!search_url) {
      return res.status(400).json({ 
        error: 'Search URL is required' 
      });
    }

    // Parse the URL and verify it is an Airbnb domain
    let urlParams;
    try {
      urlParams = new URL(search_url);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
    if (!isAirbnbHostname(urlParams.hostname)) {
      return res.status(400).json({ error: 'URL must be from an Airbnb domain' });
    }
    if (!/^\/s\/[^/]+/i.test(urlParams.pathname || '')) {
      return res.status(400).json({ error: 'Please paste an Airbnb search URL (not a listing URL)' });
    }

    const withinTrialWindow = subscriptionTier === 'free'
      ? await isWithinFreeTrialWindow(req.user.userId)
      : false;

    // Check if user already has an active free trial alert and count current alerts in one query
    const alertCheck = await query(
      `SELECT 
         COUNT(*) FILTER (WHERE is_free_trial = true AND is_active = true AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)) as free_trial_count,
         COUNT(*) FILTER (WHERE is_active = true AND (is_free_trial = false OR expires_at IS NULL OR expires_at <= CURRENT_TIMESTAMP)) as paid_alert_count,
         COUNT(*) FILTER (WHERE is_active = true) as active_alert_count
       FROM search_alerts 
       WHERE user_id = $1`,
      [req.user.userId]
    );
    
    const maxAlerts = subscriptionTier === 'premium' ? 10 : 1;
    const isFreeTrial = subscriptionTier === 'basic' || (subscriptionTier === 'free' && withinTrialWindow);
    const expiresAt = isFreeTrial
      ? new Date(Date.now() + FREE_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000)
      : null;

    const freeTrialCount = parseInt(alertCheck.rows[0].free_trial_count);
    const currentAlerts = parseInt(alertCheck.rows[0].paid_alert_count);
    const activeAlerts = parseInt(alertCheck.rows[0].active_alert_count);

    // Check limits
    if (subscriptionTier === 'free' && activeAlerts >= 1) {
      return res.status(403).json({
        error: 'Free tier allows one active alert at a time. Deactivate your existing alert to create another.',
        upgrade_required: true
      });
    }

    if (isFreeTrial && freeTrialCount > 0) {
      return res.status(403).json({ 
        error: 'Free users can only have one active alert at a time. Please upgrade to create more alerts.',
        upgrade_required: true
      });
    }

    if (!isFreeTrial && currentAlerts >= maxAlerts) {
      return res.status(403).json({ 
        error: `Maximum ${maxAlerts} active alerts for ${req.user.subscription_tier} tier`,
        upgrade_required: true
      });
    }

    // Attempt to extract common filters from the Airbnb search URL so we can
    // populate searchable columns (location, dates, guests, price, amenities)
    const parsed = parseSearchUrl(search_url) || {};

    // Create alert (store both normalized columns and raw url_params)
    const result = await query(
      `INSERT INTO search_alerts 
       (user_id, alert_type, search_url, url_params, location, check_in, check_out, ne_lat, ne_long, sw_lat, sw_long, price_min, price_max, guests, place_type, amenities, free_cancellation, is_free_trial, expires_at)
       VALUES ($1, 'search', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        req.user.userId,
        search_url,
        JSON.stringify(Object.fromEntries(urlParams.searchParams)),
        parsed.location || null,
        parsed.check_in || null,
        parsed.check_out || null,
        parsed.ne_lat || null,
        parsed.ne_long || null,
        parsed.sw_lat || null,
        parsed.sw_long || null,
        parsed.price_min || null,
        parsed.price_max || null,
        parsed.guests || null,
        parsed.place_type || null,
        JSON.stringify(parsed.amenities || []),
        parsed.free_cancellation || false,
        isFreeTrial,
        expiresAt
      ]
    );

    // Add to scraping queue (non-blocking)
    addSearchJob(result.rows[0].id).catch(err => {
      console.error('Failed to queue search job:', err);
    });

    const message = isFreeTrial 
      ? `Free alert created! This alert will expire in ${FREE_TRIAL_DURATION_DAYS} days. Upgrade to create permanent alerts.`
      : 'Alert created successfully';

    res.status(201).json({
      message,
      alert: result.rows[0],
      is_free_trial: isFreeTrial,
      expires_at: expiresAt
    });
  } catch (error) {
    console.error('Create URL alert error:', error);
    res.status(500).json({ error: 'Failed to create alert' });
  }
});

// Create new listing alert (track specific listing)
router.post('/listing', authenticateToken, async (req, res) => {
  try {
    const subscriptionTier = await resolveRequestSubscriptionTier(req);
    // Accept either explicit listing_id or a listing_url that contains the id + dates
  const { listing_id: bodyListingId, listing_url: bodyListingUrl, check_in: bodyCheckIn, check_out: bodyCheckOut } = req.body;

  let listing_id = bodyListingId || null;
  let listing_url = bodyListingUrl || null;
  let check_in = bodyCheckIn || null;
  let check_out = bodyCheckOut || null;

    // If listing_id is missing but user provided a listing URL, try to extract values from it
    if (!listing_id && listing_url) {
      const parsed = parseListingUrl(listing_url);
      if (parsed && parsed.listingId) listing_id = parsed.listingId;
      if (!check_in && parsed && parsed.check_in) check_in = parsed.check_in;
      if (!check_out && parsed && parsed.check_out) check_out = parsed.check_out;
    }

    if (!listing_id) {
      return res.status(400).json({ 
        error: 'Listing ID is required (provide listing_id or a valid listing_url)' 
      });
    }

    const withinTrialWindow = subscriptionTier === 'free'
      ? await isWithinFreeTrialWindow(req.user.userId)
      : false;

    // Check if user already has an active free trial alert and count current alerts in one query
    const alertCheck = await query(
      `SELECT 
         COUNT(*) FILTER (WHERE is_free_trial = true AND is_active = true AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)) as free_trial_count,
         COUNT(*) FILTER (WHERE is_active = true AND (is_free_trial = false OR expires_at IS NULL OR expires_at <= CURRENT_TIMESTAMP)) as paid_alert_count,
         COUNT(*) FILTER (WHERE is_active = true) as active_alert_count
       FROM search_alerts 
       WHERE user_id = $1`,
      [req.user.userId]
    );
    
    const maxAlerts = subscriptionTier === 'premium' ? 10 : 1;
    const isFreeTrial = subscriptionTier === 'basic' || (subscriptionTier === 'free' && withinTrialWindow);
    const expiresAt = isFreeTrial
      ? new Date(Date.now() + FREE_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000)
      : null;

    const freeTrialCount = parseInt(alertCheck.rows[0].free_trial_count);
    const currentAlerts = parseInt(alertCheck.rows[0].paid_alert_count);
    const activeAlerts = parseInt(alertCheck.rows[0].active_alert_count);

    // Check limits
    if (subscriptionTier === 'free' && activeAlerts >= 1) {
      return res.status(403).json({
        error: 'Free tier allows one active alert at a time. Deactivate your existing alert to create another.',
        upgrade_required: true
      });
    }

    if (isFreeTrial && freeTrialCount > 0) {
      return res.status(403).json({ 
        error: 'Free users can only have one active alert at a time. Please upgrade to create more alerts.',
        upgrade_required: true
      });
    }

    if (!isFreeTrial && currentAlerts >= maxAlerts) {
      return res.status(403).json({ 
        error: `Maximum ${maxAlerts} active alerts for ${req.user.subscription_tier} tier`,
        upgrade_required: true
      });
    }

      // Server-side validation: verify the listing ID actually exists using pyairbnb
      try {
        const details = await getListingDetails(listing_id);
        if (!details || !details.id) {
          return res.status(400).json({ error: 'Could not verify listing ID' });
        }

        // If user didn't provide a listing URL, prefer the canonical URL returned by pyairbnb
        if (!listing_url && details.url) listing_url = details.url;
      } catch (err) {
        console.error('Listing validation failed:', err);
        return res.status(400).json({ error: 'Failed to validate listing ID' });
      }

    // Create alert
    const result = await query(
      `INSERT INTO search_alerts 
       (user_id, alert_type, listing_id, listing_url, check_in, check_out, is_free_trial, expires_at)
       VALUES ($1, 'listing', $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.userId, listing_id, listing_url, check_in, check_out, isFreeTrial, expiresAt]
    );

    // Add to scraping queue (non-blocking)
    addListingJob(result.rows[0].id).catch(err => {
      console.error('Failed to queue listing job:', err);
    });

    const message = isFreeTrial 
      ? `Free alert created! This alert will expire in ${FREE_TRIAL_DURATION_DAYS} days. Upgrade to create permanent alerts.`
      : 'Listing alert created successfully';

    res.status(201).json({
      message,
      alert: result.rows[0],
      is_free_trial: isFreeTrial,
      expires_at: expiresAt
    });
  } catch (error) {
    console.error('Create listing alert error:', error);
    res.status(500).json({ error: 'Failed to create listing alert' });
  }
});

// Update alert
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    const result = await query(
      `UPDATE search_alerts 
       SET is_active = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [is_active, id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({
      message: 'Alert updated successfully',
      alert: result.rows[0]
    });
  } catch (error) {
    console.error('Update alert error:', error);
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// Run alert now (manual trigger)
router.post('/:id/run', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify the alert belongs to the user
    const alertResult = await query(
      'SELECT id, alert_type FROM search_alerts WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );

    if (alertResult.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const alert = alertResult.rows[0];

    // Add job to queue based on alert type
    if (alert.alert_type === 'search') {
      await addSearchJob(id, 'high'); // High priority for manual runs
    } else if (alert.alert_type === 'listing') {
      await addListingJob(id, 'high'); // High priority for manual runs
    }

    res.json({ message: 'Alert queued for immediate execution' });
  } catch (error) {
    console.error('Run alert error:', error);
    res.status(500).json({ error: 'Failed to run alert' });
  }
});

// Delete alert
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      'DELETE FROM search_alerts WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({ message: 'Alert deleted successfully' });
  } catch (error) {
    console.error('Delete alert error:', error);
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});

export default router;
