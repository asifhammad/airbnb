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
      `SELECT subscription_tier
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    );
    const dbTier = result?.rows?.[0]?.subscription_tier;
    return normalizeSubscriptionTier(dbTier || fallbackTier);
  } catch (error) {
    log.warn?.('Failed to resolve current subscription tier from DB, using token tier fallback', {
      userId,
      error: error?.message || error
    });
    return fallbackTier;
  }
}

