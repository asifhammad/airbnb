const VALID_TIERS = new Set(['free', 'basic', 'premium']);

export function normalizeSubscriptionTier(tier) {
  if (!tier || typeof tier !== 'string') return 'free';
  const normalized = tier.toLowerCase();
  return VALID_TIERS.has(normalized) ? normalized : 'free';
}

export async function resolveCurrentSubscriptionTier({ userId, tokenTier, dbQuery, log = console }) {
  const fallbackTier = normalizeSubscriptionTier(tokenTier);
  if (!Number.isFinite(Number(userId))) return fallbackTier;

  try {
    const result = await dbQuery(
      `SELECT subscription_tier, subscription_status
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );
    const row = result?.rows?.[0];
    if (!row) return fallbackTier;
    if (row.subscription_status && row.subscription_status !== 'active') {
      return 'free';
    }
    return normalizeSubscriptionTier(row.subscription_tier || fallbackTier);
  } catch (error) {
    log.warn?.('Failed to resolve current subscription tier from DB, using token tier fallback', {
      userId,
      error: error?.message || error
    });
    return fallbackTier;
  }
}
