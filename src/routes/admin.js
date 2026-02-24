import express from 'express';
import { query, dbStatus } from '../db/index.js';

const router = express.Router();

// ── Admin auth middleware ─────────────────────────────────────────────────────
// Protected by a static secret in the Authorization header, not a user session.
// Set ADMIN_SECRET in your .env — keep it long and random.
function requireAdminSecret(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Admin access not configured (ADMIN_SECRET not set)' });
  }
  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'Invalid or missing admin secret' });
  }
  next();
}

router.use(requireAdminSecret);

// ── GET /api/admin/alerts ─────────────────────────────────────────────────────
// Lists every active alert with last run status, result counts, and error state.
router.get('/alerts', async (req, res) => {
  try {
    const result = await query(
      `SELECT
         sa.id,
         sa.alert_type,
         sa.location,
         sa.search_url,
         sa.is_active,
         sa.is_free_trial,
         sa.expires_at,
         sa.last_checked,
         sa.last_notified,
         sa.notification_count,
         u.email        AS user_email,
         u.subscription_tier,
         -- how many listings we know about for this alert
         COUNT(DISTINCT sr.listing_id)                                      AS known_listings,
         -- how many price drops ever recorded
         COUNT(DISTINCT CASE WHEN sr.change_type = 'price_drop'
               THEN sr.listing_id END)                                      AS total_price_drops,
         -- most recent notification type sent
         (SELECT n2.notification_type FROM notifications n2
          WHERE n2.search_alert_id = sa.id
          ORDER BY n2.sent_at DESC LIMIT 1)                                 AS last_notification_type,
         -- how many consecutive runs returned zero results (proxy/block indicator)
         (SELECT COUNT(*) FROM notifications n3
          WHERE n3.search_alert_id = sa.id
            AND n3.sent_at > NOW() - INTERVAL '48 hours')                   AS notifications_last_48h,
         -- minutes since last checked
         EXTRACT(EPOCH FROM (NOW() - sa.last_checked)) / 60                AS mins_since_checked
       FROM search_alerts sa
       JOIN users u ON u.id = sa.user_id
       LEFT JOIN search_results sr ON sr.search_alert_id = sa.id
       GROUP BY sa.id, u.email, u.subscription_tier
       ORDER BY sa.last_checked DESC NULLS LAST`
    );

    // Flag alerts that look unhealthy
    const alerts = result.rows.map(a => {
      const issues = [];
      const minsSince = Number(a.mins_since_checked);

      if (a.is_active && a.subscription_tier === 'premium' && minsSince > 90) {
        issues.push(`premium alert not checked in ${Math.round(minsSince)} mins (expected ≤60)`);
      }
      if (a.is_active && a.subscription_tier !== 'premium' && minsSince > 1500) {
        issues.push(`basic alert not checked in ${Math.round(minsSince / 60)}h (expected daily)`);
      }
      if (a.is_free_trial && a.expires_at && new Date(a.expires_at) < new Date()) {
        issues.push('free trial expired but alert still active');
      }
      if (Number(a.known_listings) === 0 && a.last_checked) {
        issues.push('zero listings ever returned — possible scraper block');
      }

      return { ...a, issues, healthy: issues.length === 0 };
    });

    const summary = {
      total:     alerts.length,
      healthy:   alerts.filter(a => a.healthy).length,
      unhealthy: alerts.filter(a => !a.healthy).length,
      premium:   alerts.filter(a => a.subscription_tier === 'premium').length,
      basic:     alerts.filter(a => a.subscription_tier === 'basic').length,
      free:      alerts.filter(a => a.subscription_tier === 'free').length,
    };

    res.json({ summary, alerts });
  } catch (err) {
    console.error('Admin alerts error:', err);
    res.status(500).json({ error: 'Failed to fetch alert status' });
  }
});

// ── GET /api/admin/alerts/:id ─────────────────────────────────────────────────
// Deep-dive on a single alert: full price history sample, recent notifications,
// and last N scrape result entries.
router.get('/alerts/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [alertRes, notifRes, historyRes, resultsRes] = await Promise.all([
      query(
        `SELECT sa.*, u.email, u.subscription_tier
         FROM search_alerts sa
         JOIN users u ON u.id = sa.user_id
         WHERE sa.id = $1`,
        [id]
      ),
      query(
        `SELECT notification_type, sent_at, email_sent, email_error, listing_id
         FROM notifications
         WHERE search_alert_id = $1
         ORDER BY sent_at DESC
         LIMIT 20`,
        [id]
      ),
      query(
        `SELECT listing_id, price, recorded_at
         FROM listing_price_history
         WHERE search_alert_id = $1
         ORDER BY recorded_at DESC
         LIMIT 50`,
        [id]
      ),
      query(
        `SELECT sr.listing_id, sr.change_type, sr.old_price, sr.new_price,
                sr.detected_at, l.name, l.url
         FROM search_results sr
         LEFT JOIN listings l ON l.listing_id = sr.listing_id
         WHERE sr.search_alert_id = $1
         ORDER BY sr.detected_at DESC
         LIMIT 20`,
        [id]
      ),
    ]);

    if (alertRes.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    res.json({
      alert:        alertRes.rows[0],
      notifications: notifRes.rows,
      priceHistory:  historyRes.rows,
      results:       resultsRes.rows,
    });
  } catch (err) {
    console.error('Admin alert detail error:', err);
    res.status(500).json({ error: 'Failed to fetch alert detail' });
  }
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
// Top-level system health numbers.
router.get('/stats', async (req, res) => {
  try {
    const result = await query(
      `SELECT
         (SELECT COUNT(*) FROM users)                                        AS total_users,
         (SELECT COUNT(*) FROM search_alerts WHERE is_active = true)         AS active_alerts,
         (SELECT COUNT(*) FROM notifications
          WHERE sent_at > NOW() - INTERVAL '24 hours')                       AS notifications_24h,
         (SELECT COUNT(*) FROM notifications
          WHERE sent_at > NOW() - INTERVAL '24 hours'
            AND notification_type = 'price_drop')                            AS price_drops_24h,
         (SELECT COUNT(*) FROM notifications
          WHERE sent_at > NOW() - INTERVAL '24 hours'
            AND email_sent = false)                                           AS failed_emails_24h,
         (SELECT COUNT(*) FROM listing_price_history
          WHERE recorded_at > NOW() - INTERVAL '24 hours')                   AS price_points_recorded_24h,
         (SELECT COUNT(*) FROM search_alerts
          WHERE is_active = true
            AND last_checked < NOW() - INTERVAL '90 minutes'
            AND EXISTS (
              SELECT 1 FROM users u
              WHERE u.id = search_alerts.user_id
                AND u.subscription_tier = 'premium'
            ))                                                               AS overdue_premium_alerts,
         (SELECT COUNT(*) FROM listings)                                     AS total_listings_cached`
    );

    res.json({ stats: result.rows[0], db: dbStatus() });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
