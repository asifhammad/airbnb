import Stripe from 'stripe';
import { query } from '../db/index.js';
import logger from '../utils/logger.js';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2023-10-16',
});

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

function normalizeUserStatus(stripeStatus) {
  if (ACTIVE_STATUSES.has(stripeStatus)) return 'active';
  if (stripeStatus === 'canceled') return 'cancelled';
  return 'expired';
}

function tierFromPlanKey(planKey) {
  if (planKey === 'premium') return 'premium';
  if (planKey === 'basic') return 'basic';
  return null;
}

function normalizePlanKey(planKey) {
  return planKey ? planKey.replace(/_monthly|_yearly/, '') : null;
}

function planKeyFromPriceId(priceId, priceMap) {
  return Object.entries(priceMap)
    .find(([, p]) => p.priceId && p.priceId === priceId)?.[0] || null;
}

function inferPlanKeyFromPrice(price, priceMap) {
  if (!price) return null;
  const byId = planKeyFromPriceId(price.id, priceMap);
  if (byId) return byId;
  const lookup = String(price.lookup_key || '').toLowerCase();
  const nickname = String(price.nickname || '').toLowerCase();
  const candidate = `${lookup} ${nickname}`;
  if (candidate.includes('premium')) return 'premium_monthly';
  if (candidate.includes('basic')) return 'basic_monthly';
  return null;
}

// Upsert the local subscriptions row from a Stripe subscription object
export async function syncSubscription(sub, planMap) {
  const price = sub.items.data[0]?.price || null;
  const priceId = price?.id || null;
  const planKey = inferPlanKeyFromPrice(price, planMap);
  const normalizedPlanKey = normalizePlanKey(planKey);
  const tierFromPlan = tierFromPlanKey(normalizedPlanKey);
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000)
    : null;

  // Find user by stripe_customer_id
  const userRes = await query(
    'SELECT id FROM users WHERE stripe_customer_id = $1',
    [sub.customer]
  );
  if (!userRes.rows.length) return;
  const userId = userRes.rows[0].id;

  const existingRes = await query(
    `SELECT subscription_tier
     FROM users
     WHERE id = $1`,
    [userId]
  );
  const existingTier = existingRes.rows[0]?.subscription_tier || 'free';
  const active = ACTIVE_STATUSES.has(sub.status);
  const nextTier = active
    ? (tierFromPlan || (existingTier !== 'free' ? existingTier : 'basic'))
    : 'free';

  await query(
    `INSERT INTO subscriptions
       (user_id, stripe_subscription_id, stripe_price_id, plan, interval,
        status, current_period_end, cancel_at_period_end, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       stripe_price_id        = EXCLUDED.stripe_price_id,
       plan                   = EXCLUDED.plan,
       interval               = EXCLUDED.interval,
       status                 = EXCLUDED.status,
       current_period_end     = EXCLUDED.current_period_end,
       cancel_at_period_end   = EXCLUDED.cancel_at_period_end,
       updated_at             = CURRENT_TIMESTAMP`,
    [
      userId,
      sub.id,
      priceId,
      normalizedPlanKey || (existingTier !== 'free' ? existingTier : 'basic'),
      price?.recurring?.interval || null,
      sub.status,
      periodEnd,
      sub.cancel_at_period_end,
    ]
  );

  // Keep users.subscription_tier/status in sync for JWT + alert checks
  const subscriptionStatus = normalizeUserStatus(sub.status);
  await query(
    `UPDATE users
     SET subscription_tier = $1,
         subscription_status = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [nextTier, subscriptionStatus, userId]
  );
}

export async function fetchAndSyncSubscription(stripeSubscriptionId, planMap) {
  if (!stripeSubscriptionId) return false;
  try {
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    await syncSubscription(sub, planMap);
    return true;
  } catch (err) {
    logger.warn(`Stripe reconciliation failed for ${stripeSubscriptionId}: ${err.message}`);
    return false;
  }
}
