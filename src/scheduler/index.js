import cron from 'node-cron';
import { query } from '../db/index.js';
import { addSearchJob, addListingJob } from '../workers/queue.js';
import logger from '../utils/logger.js';
import { fetchAndSyncSubscription } from '../services/stripeSubscriptions.js';
import { PLANS } from '../routes/billing.js';

/**
 * Schedule periodic scraping jobs based on subscription tiers
 */
export function startScheduler() {
  async function enqueueAlert(alert, priority) {
    try {
      if (alert.alert_type === 'search') {
        await addSearchJob(alert.id, priority);
      } else if (alert.alert_type === 'listing') {
        await addListingJob(alert.id, priority);
      }
      return true;
    } catch (err) {
      logger.warn(`Failed to queue alert ${alert.id} (${priority}): ${err.message}`);
      return false;
    }
  }

  // Check basic tier alerts (once per day at 9 AM)
  cron.schedule('0 9 * * *', async () => {
    logger.info('Running daily basic tier scraping...');
    
    try {
      const result = await query(
        `SELECT sa.id, sa.alert_type, u.subscription_tier 
         FROM search_alerts sa
         JOIN users u ON u.id = sa.user_id
         WHERE sa.is_active = true 
         AND (
           (u.subscription_tier = 'basic' AND u.subscription_status = 'active')
           OR (u.subscription_tier = 'free')
           OR (sa.is_free_trial = true AND sa.expires_at > NOW())
         )`
      );

      let queued = 0;
      for (const alert of result.rows) {
        if (await enqueueAlert(alert, 'normal')) queued += 1;
      }

      logger.info(`Queued ${queued}/${result.rows.length} basic/free tier and free trial alerts`);
    } catch (error) {
      logger.error('Basic tier scheduling error:', error);
    }
  });

  // Check premium tier alerts (every 1 hour)
  cron.schedule('0 * * * *', async () => {
    logger.info('Running premium tier scraping...');
    
    try {
      const result = await query(
        `SELECT sa.id, sa.alert_type, u.subscription_tier 
         FROM search_alerts sa
         JOIN users u ON u.id = sa.user_id
         WHERE sa.is_active = true 
         AND u.subscription_tier = 'premium'
         AND u.subscription_status = 'active'`
      );

      let queued = 0;
      for (const alert of result.rows) {
        if (await enqueueAlert(alert, 'high')) queued += 1;
      }

      logger.info(`Queued ${queued}/${result.rows.length} premium tier alerts`);
    } catch (error) {
      logger.error('Premium tier scheduling error:', error);
    }
  });

  // Clean up old notifications (daily at 3 AM)
  cron.schedule('0 3 * * *', async () => {
    logger.info('Cleaning up old notifications...');
    
    try {
      const result = await query(
        `DELETE FROM notifications 
         WHERE sent_at < NOW() - INTERVAL '30 days'`
      );
      
      logger.info(`Cleaned up ${result.rowCount} old notifications`);
    } catch (error) {
      logger.error('Cleanup error:', error);
    }
  });

  // Clean up old search results (weekly on Sunday at 2 AM)
  cron.schedule('0 2 * * 0', async () => {
    logger.info('Cleaning up old search results...');
    
    try {
      const result = await query(
        `DELETE FROM search_results 
         WHERE detected_at < NOW() - INTERVAL '60 days'`
      );
      
      logger.info(`Cleaned up ${result.rowCount} old search results`);
    } catch (error) {
      logger.error('Search results cleanup error:', error);
    }
  });

  // Clean up old price history (weekly on Sunday at 2:30 AM)
  // Keep only 90 days — enough to show meaningful trends without unbounded growth
  cron.schedule('30 2 * * 0', async () => {
    logger.info('Cleaning up old price history...');
    try {
      const result = await query(
        `DELETE FROM listing_price_history
         WHERE recorded_at < NOW() - INTERVAL '90 days'`
      );
      logger.info(`Cleaned up ${result.rowCount} old price history rows`);
    } catch (error) {
      logger.error('Price history cleanup error:', error);
    }
  });

  // Reconcile Stripe subscriptions daily (4:30 AM) to guard against webhook misses
  cron.schedule('30 4 * * *', async () => {
    if (!process.env.STRIPE_SECRET_KEY) {
      logger.warn('Stripe reconciliation skipped: STRIPE_SECRET_KEY not configured');
      return;
    }
    logger.info('Running daily Stripe subscription reconciliation...');
    try {
      const result = await query(
        `SELECT stripe_subscription_id
         FROM subscriptions
         WHERE stripe_subscription_id IS NOT NULL
           AND status IN ('active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired')
         ORDER BY updated_at DESC
         LIMIT 200`
      );
      let synced = 0;
      for (const row of result.rows) {
        if (await fetchAndSyncSubscription(row.stripe_subscription_id, PLANS)) {
          synced += 1;
        }
      }
      logger.info(`Stripe reconciliation finished (${synced}/${result.rows.length} synced)`);
    } catch (error) {
      logger.error('Stripe reconciliation error:', error);
    }
  });

  // Deactivate expired free trial alerts (every hour)
  cron.schedule('0 * * * *', async () => {
    logger.info('Checking for expired free trial alerts...');
    
    try {
      const result = await query(
        `UPDATE search_alerts 
         SET is_active = false 
         WHERE is_free_trial = true 
         AND expires_at IS NOT NULL 
         AND expires_at < NOW() 
         AND is_active = true`
      );
      
      if (result.rowCount > 0) {
        logger.info(`Deactivated ${result.rowCount} expired free trial alerts`);
      }
    } catch (error) {
      logger.error('Free trial cleanup error:', error);
    }
  });

  // Deactivate alerts whose entire date window is in the past (every hour)
  // Safety net in case the per-job check inside runSearchAlert is delayed
  // (e.g. queue backlog). check_out < today means the stay can no longer be
  // booked for any part of the alert's window.
  cron.schedule('0 * * * *', async () => {
    logger.info('Checking for alerts with past date windows...');
    
    try {
      const result = await query(
        `UPDATE search_alerts 
         SET is_active = false,
             updated_at = CURRENT_TIMESTAMP
         WHERE is_active = true 
         AND alert_type = 'search'
         AND check_in IS NOT NULL
         AND check_out IS NOT NULL
         AND check_out < CURRENT_DATE`
      );
      
      if (result.rowCount > 0) {
        logger.info(`Deactivated ${result.rowCount} alert(s) with past check-out dates`);
      }

      // Also deactivate alerts where only check_in is set and it's in the past
      const result2 = await query(
        `UPDATE search_alerts 
         SET is_active = false,
             updated_at = CURRENT_TIMESTAMP
         WHERE is_active = true 
         AND alert_type = 'search'
         AND check_in IS NOT NULL
         AND check_out IS NULL
         AND check_in < CURRENT_DATE`
      );
      
      if (result2.rowCount > 0) {
        logger.info(`Deactivated ${result2.rowCount} alert(s) with past check-in dates (no check-out)`);
      }
    } catch (error) {
      logger.error('Past-date alert cleanup error:', error);
    }
  });

  logger.info('✅ Scheduler started');
  logger.info('📅 Basic/free tiers: Daily at 9 AM');
  logger.info('📅 Premium tier: Every hour');
  logger.info('🧹 Cleanup: Daily at 3 AM, weekly on Sunday at 2 AM');
  logger.info('� Past-date alert deactivation: Every hour');
  logger.info('�🔁 Stripe reconciliation: Daily at 4:30 AM');
}

export default { startScheduler };
