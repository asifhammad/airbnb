#!/usr/bin/env node
import assert from 'assert';
import { resolveCurrentSubscriptionTier } from '../src/utils/subscriptionTier.js';

async function main() {
  const premiumFromDb = await resolveCurrentSubscriptionTier({
    userId: 42,
    tokenTier: 'free',
    dbQuery: async () => ({ rows: [{ subscription_tier: 'premium' }] })
  });
  assert.equal(premiumFromDb, 'premium', 'DB tier should override stale token tier');

  const fallbackToToken = await resolveCurrentSubscriptionTier({
    userId: 42,
    tokenTier: 'basic',
    dbQuery: async () => {
      throw new Error('db unavailable');
    },
    log: { warn: () => {} }
  });
  assert.equal(fallbackToToken, 'basic', 'Should fall back to token tier when DB lookup fails');

  const invalidTierFallback = await resolveCurrentSubscriptionTier({
    userId: 42,
    tokenTier: 'gold',
    dbQuery: async () => ({ rows: [] })
  });
  assert.equal(invalidTierFallback, 'free', 'Invalid tier values should normalize to free');

  console.log('✅ subscription tier resolution prefers DB values and safely falls back');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Test failed:', err.message || err);
  process.exit(1);
});

