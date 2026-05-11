#!/usr/bin/env node
import assert from 'assert';
import { runSearchAlert } from '../src/workers/scraper-worker.js';

async function main() {
  const alertId = 901;
  const knownListingId = 'known-1';
  const validNewId = 'new-valid-1';
  const invalidNewId = 'new-invalid-0';
  const notificationRows = [];

  const mockDbQuery = async (sql, params = []) => {
    if (sql.includes('SELECT * FROM search_alerts WHERE id = $1 AND is_active = true')) {
      return {
        rows: [{
          id: alertId,
          user_id: 88,
          is_active: true,
          check_in: '2026-06-10',
          check_out: '2026-06-12',
          search_url: 'https://www.airbnb.com/s/test-city/homes',
          url_params: null,
          price_min: null,
          price_max: null,
          currency: 'USD',
          guests: 2,
          location: 'Test City',
        }],
      };
    }
    if (sql.includes('WITH known_ids AS')) {
      return { rows: [{ listing_id: knownListingId, last_price: 300 }] };
    }
    if (sql.includes('SELECT last_notified FROM search_alerts')) {
      return { rows: [{ last_notified: null }] };
    }
    if (sql.includes('SELECT u.subscription_tier FROM users u')) {
      return { rows: [{ subscription_tier: 'premium' }] };
    }
    if (sql.includes('SELECT COUNT(*)::int AS sent_count')) {
      return { rows: [{ sent_count: 0 }] };
    }
    if (sql.includes('FROM notifications') && sql.includes("notification_type = 'price_drop'")) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO notifications')) {
      notificationRows.push(params);
      return { rowCount: 1, rows: [] };
    }
    return { rows: [], rowCount: 1 };
  };

  let searchCalls = 0;
  const mockSearchFn = async () => {
    searchCalls += 1;
    return [
      { id: knownListingId, name: 'Known', price: 300, url: `https://www.airbnb.com/rooms/${knownListingId}` },
      { id: validNewId, name: 'Valid New', price: 250, url: `https://www.airbnb.com/rooms/${validNewId}` },
      { id: invalidNewId, name: 'Invalid New', price: 0, url: `https://www.airbnb.com/rooms/${invalidNewId}` },
    ];
  };

  const result = await runSearchAlert(alertId, { searchFn: mockSearchFn, dbQuery: mockDbQuery });

  assert.equal(result.status, 'success');
  assert.equal(result.newListings, 1, 'Only valid priced listing should be counted as new');
  assert.equal(searchCalls, 2, 'Expected initial scrape + pre-send validation scrape');

  const queuedListingIds = notificationRows.map((p) => p[2]);
  assert.deepEqual(queuedListingIds, [validNewId], 'Zero-priced listing should never be queued for email');

  console.log('✅ runSearchAlert filters invalid/non-positive prices before queueing notifications');
}

main().catch((err) => {
  console.error('❌ Test failed:', err?.stack || err?.message || err);
  process.exit(1);
});

