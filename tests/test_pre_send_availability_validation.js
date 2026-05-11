#!/usr/bin/env node
import assert from 'assert';

async function main() {
  process.env.ENABLE_ICAL_MONITORING = 'false';
  process.env.WORKER_AUTOSTART = 'false';
  const { runSearchAlert } = await import('../src/workers/scraper-worker.js');

  const alertId = 901;
  const knownListingId = '1001';
  const newListingId = '1002';
  const notificationWrites = [];
  let searchCallCount = 0;

  const mockSearchFn = async () => {
    searchCallCount += 1;
    // First call: worker detection pass
    if (searchCallCount === 1) {
      return [
        { id: knownListingId, name: 'Known listing', price: 280, url: `https://www.airbnb.com/rooms/${knownListingId}` },
        { id: newListingId, name: 'New listing', price: 220, url: `https://www.airbnb.com/rooms/${newListingId}` },
      ];
    }
    // Second call: pre-send validation pass (known listing disappeared)
    return [
      { id: newListingId, name: 'New listing', price: 220, url: `https://www.airbnb.com/rooms/${newListingId}` },
    ];
  };

  const mockDbQuery = async (sql, params = []) => {
    if (sql.includes('SELECT * FROM search_alerts WHERE id = $1 AND is_active = true')) {
      return {
        rows: [{
          id: alertId,
          user_id: 123,
          is_active: true,
          check_in: '2026-06-10',
          check_out: '2026-06-12',
          search_url: 'https://www.airbnb.com/s/test-city/homes?checkin=2026-06-10&checkout=2026-06-12',
          url_params: null,
          location: 'Test City',
          guests: 2,
        }],
      };
    }

    if (sql.includes('WITH known_ids AS')) {
      return { rows: [{ listing_id: knownListingId, last_price: 340 }] };
    }

    if (sql.includes('FROM notifications') && sql.includes("notification_type = 'price_drop'")) {
      return { rows: [] };
    }

    if (sql.includes('SELECT price, recorded_at FROM listing_price_history')) {
      return { rows: [{ price: 340, recorded_at: '2026-02-20T00:00:00.000Z' }] };
    }

    if (sql.includes('SELECT u.subscription_tier FROM users u')) {
      return { rows: [{ subscription_tier: 'premium' }] };
    }

    if (sql.includes('SELECT last_notified FROM search_alerts WHERE id = $1')) {
      return { rows: [{ last_notified: null }] };
    }

    if (sql.includes('SELECT COUNT(*)::int AS sent_count')) {
      return { rows: [{ sent_count: 0 }] };
    }

    if (sql.includes('INSERT INTO notifications')) {
      notificationWrites.push(params);
      return { rowCount: 1, rows: [] };
    }

    return { rows: [], rowCount: 1 };
  };

  const result = await runSearchAlert(alertId, {
    searchFn: mockSearchFn,
    dbQuery: mockDbQuery,
  });

  assert.equal(result.status, 'success');
  assert.equal(searchCallCount, 2, 'Expected one detection scrape + one pre-send validation scrape');

  const queuedListingIds = notificationWrites.map((p) => p[2]).sort();
  const queuedTypes = notificationWrites.map((p) => p[3]).sort();

  assert.deepEqual(queuedListingIds, [newListingId], 'Only listings still present during pre-send validation should queue');
  assert.deepEqual(queuedTypes, ['new_listing']);

  console.log('✅ pre-send availability validation prevents stale price-drop notification queueing');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Test failed:', err.message || err);
  process.exit(1);
});
