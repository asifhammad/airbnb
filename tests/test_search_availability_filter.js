#!/usr/bin/env node
/*
  Test that search alerts respect check_in/check_out availability when
  deciding which listings match a search alert.
*/
import assert from 'assert';
import { query } from '../src/db/index.js';
import { runSearchAlert } from '../src/workers/scraper-worker.js';

async function createTestUser() {
  const res = await query("INSERT INTO users (email, subscription_tier) VALUES ($1, $2) RETURNING id", ['test+avail@example.com', 'premium']);
  return res.rows[0].id;
}

async function cleanup(userId, alertId, listingIds=[]) {
  try {
    if (alertId) await query('DELETE FROM search_alerts WHERE id = $1', [alertId]);
    if (userId) await query('DELETE FROM users WHERE id = $1', [userId]);
    for (const lid of listingIds) {
      await query('DELETE FROM listings WHERE listing_id = $1', [lid]);
      await query('DELETE FROM search_results WHERE listing_id = $1', [lid]);
      await query('DELETE FROM notifications WHERE listing_id = $1', [lid]);
    }
  } catch (e) {
    // best-effort
  }
}

(async function main(){
  const availableId = `avail-${Date.now()}`;
  const unavailableId = `unavail-${Date.now()}`;
  let userId = null;
  let alertId = null;

  try {
    userId = await createTestUser();
    const checkIn = '2026-03-03';
    const checkOut = '2026-03-10';

    const alertRes = await query(
      `INSERT INTO search_alerts (user_id, alert_type, location, check_in, check_out, is_active, created_at, updated_at)
       VALUES ($1, 'search', $2, $3, $4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
      [userId, 'Test area', checkIn, checkOut]
    );
    alertId = alertRes.rows[0].id;

    // Ensure listings table empty for these ids
    await query('DELETE FROM listings WHERE listing_id = ANY($1)', [[availableId, unavailableId]]);

    // Mock search results: both listings present
    const mockSearch = async (params) => {
      return [
        { id: availableId, url: 'https://airbnb/avail', name: 'Available', price: 200, currency: 'USD', badges: [], beds: 1, bedrooms: 1 },
        { id: unavailableId, url: 'https://airbnb/unavail', name: 'Unavailable', price: 150, currency: 'USD', badges: [], beds: 1, bedrooms: 1 }
      ];
    };

    // Mock iCal: only `availableId` is available for the dates
    const mockICal = async (listingId, ci, co) => {
      if (listingId === availableId) return true;
      return false;
    };

    // Run the alert
    const res = await runSearchAlert(alertId, { searchFn: mockSearch, checkICalFn: mockICal, sendEmailFn: async ()=>({}) });
    console.log('runSearchAlert result:', res);

    // Verify only availableId was recorded in search_results as 'new'
    const srRows = await query('SELECT * FROM search_results WHERE search_alert_id = $1 AND listing_id = ANY($2)', [alertId, [availableId, unavailableId]]);
    assert(srRows.rows.length === 1, 'Expected only one search_results row for the available listing');
    assert(srRows.rows[0].listing_id === availableId, 'Expected the available listing to be recorded');

    // Verify notification logged only for available listing
    const notifRows = await query('SELECT * FROM notifications WHERE search_alert_id = $1 AND listing_id = ANY($2)', [alertId, [availableId, unavailableId]]);
    assert(notifRows.rows.length >= 1, 'Expected notification for available listing');
    assert(!notifRows.rows.some(r => r.listing_id === unavailableId), 'Did not expect notification for unavailable listing');

    console.log('✅ Availability filter test passed');
  } catch (err) {
    console.error('❌ Test failed:', err && err.message || err);
    process.exitCode = 1;
  } finally {
    await cleanup(userId, alertId, [availableId, unavailableId]);
    process.exit();
  }
})();