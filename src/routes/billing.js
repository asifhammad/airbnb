import express from 'express';
import Stripe from 'stripe';
import { query } from '../db/index.js';
import { authenticateToken } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2023-10-16',
});

// ─── Plan config (single source of truth) ─────────────────────────────────────
export const PLANS = {
  free: {
    name:      'Free',
    alertsMax: 0,
    interval:  null,
    price:     0,
    priceId:   null,
  },
  basic_monthly: {
    name:      'Basic',
    alertsMax: 1,
    interval:  'month',
    price:     4.99,
    priceId:   process.env.STRIPE_PRICE_BASIC_MONTHLY,
    dbTier:    'basic',
  },
  premium_monthly: {
    name:      'Premium',
    alertsMax: 10,
    interval:  'month',
    price:     14.99,
    priceId:   process.env.STRIPE_PRICE_PREMIUM_MONTHLY,
    dbTier:    'premium',
  },
  premium_yearly: {
    name:      'Premium (yearly)',
    alertsMax: 10,
    interval:  'year',
    price:     89.99,
    priceId:   process.env.STRIPE_PRICE_PREMIUM_YEARLY,
    dbTier:    'premium',
  },
};

// Map a Stripe price ID back to a plan key
function planKeyFromPriceId(priceId) {
  return Object.entries(PLANS).find(([, p]) => p.priceId && p.priceId === priceId)?.[0] || null;
}

// Map plan key → subscription_tier for the users table
function tierFromPlanKey(planKey) {
  return PLANS[planKey]?.dbTier || 'free';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getOrCreateStripeCustomer(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const customer = await stripe.customers.create({
    email:    user.email,
    metadata: { userId: String(user.id) },
  });

  await query(
    'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
    [customer.id, user.id]
  );
  return customer.id;
}

// Queue billing-related transactional email events for Dreamlit (DB-triggered flow).
async function enqueueBillingEmailEvent(userId, eventType, payload = {}) {
  try {
    const userRes = await query(
      'SELECT email FROM users WHERE id = $1',
      [userId]
    );
    const email = userRes.rows[0]?.email;
    if (!email) return;

    await query(
      `INSERT INTO transactional_email_events
         (user_id, recipient_email, event_type, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 'pending')`,
      [userId, email, eventType, JSON.stringify(payload || {})]
    );
  } catch (err) {
    // Do not break billing if the email-events table is unavailable.
    logger.warn('Failed to enqueue billing email event:', err.message);
  }
}

async function findUserByStripeCustomerId(stripeCustomerId) {
  const userRes = await query(
    'SELECT id, email FROM users WHERE stripe_customer_id = $1',
    [stripeCustomerId]
  );
  return userRes.rows[0] || null;
}

async function markWebhookEventStarted(event) {
  try {
    const result = await query(
      `INSERT INTO stripe_webhook_events (event_id, event_type)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [event.id, event.type]
    );
    return result.rows.length > 0;
  } catch (err) {
    if (err?.code === '42P01') {
      logger.warn('stripe_webhook_events table missing; processing webhook without idempotency ledger');
      return true;
    }
    throw err;
  }
}

async function markWebhookEventProcessed(eventId) {
  try {
    await query(
      `UPDATE stripe_webhook_events
       SET processed_at = CURRENT_TIMESTAMP
       WHERE event_id = $1`,
      [eventId]
    );
  } catch (err) {
    if (err?.code !== '42P01') throw err;
  }
}

// Upsert the local subscriptions row from a Stripe subscription object
async function syncSubscription(sub) {
  const planKey = planKeyFromPriceId(sub.items.data[0]?.price?.id);
  const tier    = tierFromPlanKey(planKey);
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
      sub.items.data[0]?.price?.id,
      planKey?.replace(/_monthly|_yearly/, '') || 'basic', // 'basic' or 'premium'
      sub.items.data[0]?.price?.recurring?.interval || null,
      sub.status,
      periodEnd,
      sub.cancel_at_period_end,
    ]
  );

  // Keep users.subscription_tier in sync for the JWT / alert limit checks
  const activeStatuses = ['active', 'trialing'];
  await query(
    `UPDATE users SET subscription_tier = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [activeStatuses.includes(sub.status) ? tier : 'free', userId]
  );
}

// ─── GET /api/billing/subscription ───────────────────────────────────────────
// Returns the user's current plan + subscription row
router.get('/subscription', authenticateToken, async (req, res) => {
  try {
    const userRes = await query(
      `SELECT id, email, subscription_tier, stripe_customer_id
       FROM users WHERE id = $1`,
      [req.user.userId]
    );
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];

    const subRes = await query(
      `SELECT * FROM subscriptions WHERE user_id = $1`,
      [user.id]
    );
    const sub = subRes.rows[0] || null;

    res.json({
      subscription_tier: user.subscription_tier,
      subscription: sub,
      plans: PLANS,
    });
  } catch (err) {
    logger.error('GET /billing/subscription error:', err);
    res.status(500).json({ error: 'Failed to load subscription' });
  }
});

// ─── POST /api/billing/checkout ──────────────────────────────────────────────
// Creates a Stripe Checkout Session for the selected plan
router.post('/checkout', authenticateToken, async (req, res) => {
  try {
    const { plan_key } = req.body; // e.g. 'basic_monthly'
    const plan = PLANS[plan_key];
    if (!plan || !plan.priceId) {
      return res.status(400).json({ error: 'Invalid plan selected.' });
    }

    const userRes = await query(
      'SELECT id, email, stripe_customer_id FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];

    const customerId = await getOrCreateStripeCustomer(user);

    // Check if already subscribed — send to portal instead
    const existingSub = await query(
      `SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1`,
      [user.id]
    );
    if (existingSub.rows.length && ['active', 'trialing'].includes(existingSub.rows[0].status)) {
      return res.status(400).json({
        error: 'You already have an active subscription. Use the manage portal to change plans.',
        already_subscribed: true,
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: plan.priceId, quantity: 1 }],
      success_url: `${process.env.API_BASE_URL}/billing?checkout=success`,
      cancel_url:  `${process.env.API_BASE_URL}/billing?checkout=cancelled`,
      metadata: {
        userId:   String(user.id),
        plan_key,
      },
      subscription_data: {
        metadata: { userId: String(user.id), plan_key },
      },
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (err) {
    logger.error('POST /billing/checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

// ─── POST /api/billing/portal ─────────────────────────────────────────────────
// Creates a Stripe Customer Portal session (manage/cancel/switch plan)
router.post('/portal', authenticateToken, async (req, res) => {
  try {
    const userRes = await query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.user.userId]
    );
    const user = userRes.rows[0];
    if (!user?.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found. Please subscribe first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripe_customer_id,
      return_url: `${process.env.API_BASE_URL}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    logger.error('POST /billing/portal error:', err);
    res.status(500).json({ error: 'Failed to open billing portal.' });
  }
});

// ─── Stripe webhook handler ────────────────────────────────────────────────
// Exported separately so index.js can mount it BEFORE express.json() is applied.
// Stripe signature verification requires the raw Buffer; if express.json() runs
// first it parses the body to an object and the signature check always fails.
export async function stripeWebhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.warn('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const shouldProcess = await markWebhookEventStarted(event);
    if (!shouldProcess) {
      logger.info(`Stripe webhook replay ignored: ${event.id} (${event.type})`);
      return res.json({ received: true, duplicate: true });
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await syncSubscription(sub);
          const userId = Number(session?.metadata?.userId);
          if (Number.isFinite(userId)) {
            await enqueueBillingEmailEvent(userId, 'subscription_started', {
              stripe_subscription_id: sub.id,
              status: sub.status,
              plan_key: session?.metadata?.plan_key || null,
            });
          }
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.created':
        await syncSubscription(event.data.object);
        {
          const sub = event.data.object;
          const user = await findUserByStripeCustomerId(sub.customer);
          if (user?.id) {
            await enqueueBillingEmailEvent(user.id, 'subscription_updated', {
              stripe_subscription_id: sub.id,
              status: sub.status,
              cancel_at_period_end: sub.cancel_at_period_end,
              current_period_end: sub.current_period_end || null,
            });
          }
        }
        break;

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await query(
          `UPDATE subscriptions SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
           WHERE stripe_subscription_id = $1`,
          [sub.id]
        );
        const userRes = await query(
          'SELECT id FROM users WHERE stripe_customer_id = $1',
          [sub.customer]
        );
        if (userRes.rows.length) {
          await query(
            `UPDATE users SET subscription_tier = 'free', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [userRes.rows[0].id]
          );
          await enqueueBillingEmailEvent(userRes.rows[0].id, 'subscription_canceled', {
            stripe_subscription_id: sub.id,
            status: sub.status,
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await query(
            `UPDATE subscriptions SET status = 'past_due', updated_at = CURRENT_TIMESTAMP
             WHERE stripe_subscription_id = $1`,
            [invoice.subscription]
          );
          const userRes = await query(
            `SELECT user_id
             FROM subscriptions
             WHERE stripe_subscription_id = $1
             LIMIT 1`,
            [invoice.subscription]
          );
          if (userRes.rows.length) {
            await enqueueBillingEmailEvent(userRes.rows[0].user_id, 'invoice_payment_failed', {
              stripe_subscription_id: invoice.subscription,
              invoice_id: invoice.id || null,
              amount_due: invoice.amount_due || null,
              currency: invoice.currency || null,
            });
          }
        }
        break;
      }

      default:
        break;
    }

    await markWebhookEventProcessed(event.id);
    res.json({ received: true });
  } catch (err) {
    logger.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

export default router;
