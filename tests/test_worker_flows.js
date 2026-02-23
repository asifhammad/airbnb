#!/usr/bin/env node
/*
  Integration test for price-drop and freed_up flows in scraper worker.
  - Inserts a test user + alert
  - Inserts a listings row + search_results mapping to simulate existing listing
  - Mocks searchAirbnb results and iCal availability
  - Calls runSearchAlert and asserts DB changes

  Run with: node tests/test_worker_flows.js
*/
import assert from 'assert';
import { query } from '../src/db/index.js';
import { runSearchAlert } from '../src/workers/scraper-worker.js';

async function createTestUser() {
  const res = await query("INSERT INTO users (email, subscription_tier) VALUES ($1, $2) RETURNING id", ['test+worker@example.com', 'premium']);
  return res.rows[0].id;
}

async function cleanupTestData(userId, alertId, listingId) {
  try {
    if (alertId) await query('DELETE FROM search_alerts WHERE id = $1', [alertId]);
    if (userId) await query('DELETE FROM users WHERE id = $1', [userId]);
    if (listingId) await query('DELETE FROM listings WHERE listing_id = $1', [listingId]);
    await query("DELETE FROM search_results WHERE listing_id = $1", [listingId]);
    await query("DELETE FROM notifications WHERE listing_id = $1", [listingId]);
  } catch (e) {
    console.warn('Cleanup warning', e.message || e);
  }
}

async function main() {
  const testListingId = `test-listing-${Date.now()}`;
  let userId = null;
  let alertId = null;

  try {
    userId = await createTestUser();

    const checkIn = '2026-03-10';
    const checkOut = '2026-03-12';

    const alertRes = await query(
      `INSERT INTO search_alerts (user_id, alert_type, location, check_in, check_out, is_active, created_at, updated_at)
       VALUES ($1, 'search', $2, $3, $4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`,
      [userId, 'Test area', checkIn, checkOut]
    );
    alertId = alertRes.rows[0].id;

    // Insert an existing listing and associate it with the alert so the worker treats it as "existing"
    const oldPrice = 500;
    await query(`INSERT INTO listings (listing_id, url, name, price, currency, first_seen) VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP) ON CONFLICT (listing_id) DO UPDATE SET price = EXCLUDED.price`, [testListingId, 'https://example.com', 'Test Listing', oldPrice, 'USD']);

    await query(`INSERT INTO search_results (search_alert_id, listing_id, change_type, new_price) VALUES ($1,$2,'new',$3)`, [alertId, testListingId, oldPrice]);

    // Mocked search function will return the same listing with a lower price
    const mockSearchFn = async (params) => {
      return [
        {
          id: testListingId,
          url: 'https://example.com',
          name: 'Test Listing',
          price: 300, // new lower price
          currency: 'USD',
          rating: 4.5,
          reviewsCount: 10,
          roomType: 'Entire home',
          guests: 2,
          address: '123 Test St'
        }
      ];
    };

    // Mock iCal function to mark the listing as available for the alert dates
    const mockCheckICal = async (listingId, checkInParam, checkOutParam) => {
      // return true to indicate availability
      return true;
    };

    console.log('Running worker for price-drop + freed_up detection...');
    // Mock sendEmailFn so tests don't attempt to send real emails
    const mockSendEmail = async (userEmail, alert, listings, opts = {}) => {
      console.log('mockSendEmail called:', userEmail, listings.map(l => l.id || l.listing_id));
      return { success: true };
    };

    const result = await runSearchAlert(alertId, { searchFn: mockSearchFn, checkICalFn: mockCheckICal, sendEmailFn: mockSendEmail });
    console.log('Worker result:', result);
    console.log('\n--- search_results rows for this alert/listing ---');
    const allRows = await query(`SELECT * FROM search_results WHERE search_alert_id = $1 AND listing_id = $2 ORDER BY detected_at`, [alertId, testListingId]);
    console.log(JSON.stringify(allRows.rows, null, 2));

  // Verify notifications were logged for both price_drop and availability_change
  const priceNotif = await query(`SELECT * FROM notifications WHERE search_alert_id = $1 AND listing_id = $2 AND notification_type = 'price_drop'`, [alertId, testListingId]);
  assert(priceNotif.rows.length >= 1, 'Expected a price_drop notification for this alert/listing');

  const availNotif = await query(`SELECT * FROM notifications WHERE search_alert_id = $1 AND listing_id = $2 AND notification_type = 'availability_change'`, [alertId, testListingId]);
  assert(availNotif.rows.length >= 1, 'Expected an availability_change notification for this alert/listing');

  // The single search_results row is updated to reflect the latest change (we upsert on conflict).
  const sr = allRows.rows[allRows.rows.length - 1];
  assert(sr.new_price == 300, 'Expected search_results new_price to be updated to 300');

    console.log('✅ Price-drop and freed_up flows validated successfully');
  } catch (err) {
    console.error('❌ Test failed:', err.message || err);
    process.exitCode = 1;
  } finally {
    await cleanupTestData(userId, alertId, testListingId);
    process.exit();
  }
}

main();
