#!/usr/bin/env node
/*
  Deterministic end-to-end verification for search-alert worker + notifications.

  What it does:
  1) Creates a disposable premium user + search alert from TEST_SEARCH_URL.
  2) Runs runSearchAlert once to establish baseline listings/prices.
  3) Forces a higher historical baseline for one returned listing.
  4) Runs runSearchAlert again.
  5) Verifies a price_drop notification was written with payload JSON.

  Usage:
    TEST_SEARCH_URL="https://www.airbnb.com/s/..." node tests/test_e2e_search_alert_price_drop.js

  Optional env:
    TEST_ALERT_EMAIL="you@example.com"      # default: e2e+timestamp@example.com
    KEEP_TEST_DATA="1"                      # keep created user/alert rows for inspection
    SEND_REAL_EMAIL="1"                     # use real mailer instead of mocked sender
*/

import { query } from '../src/db/index.js';
import parseSearchUrl from '../src/utils/parseSearchUrl.js';
import { searchAirbnb } from '../src/workers/python-executor.js';

function fail(message) {
  throw new Error(message);
}

async function cleanup(ids) {
  const { userId, alertId } = ids;
  if (!userId && !alertId) return;
  if (alertId) {
    await query('DELETE FROM search_alerts WHERE id = $1', [alertId]);
  }
  if (userId) {
    await query('DELETE FROM users WHERE id = $1', [userId]);
  }
}

async function syncSequence(table, column = 'id') {
  await query(
    `SELECT setval(
       pg_get_serial_sequence($1, $2),
       COALESCE((SELECT MAX(${column}) FROM ${table}), 1),
       true
     )`,
    [table, column]
  );
}

async function syncCommonSequences() {
  await syncSequence('users', 'id');
  await syncSequence('search_alerts', 'id');
  await syncSequence('notifications', 'id');
}

async function createTestUser(email) {
  const res = await query(
    `INSERT INTO users (email, subscription_tier, subscription_status, email_verified)
     VALUES ($1, 'premium', 'active', true)
     RETURNING id, email`,
    [email]
  );
  return res.rows[0];
}

async function createSearchAlert(userId, searchUrl) {
  const parsed = parseSearchUrl(searchUrl) || {};
  const res = await query(
    `INSERT INTO search_alerts
       (user_id, alert_type, is_active, search_url, url_params, location, check_in, check_out,
        ne_lat, ne_long, sw_lat, sw_long, price_min, price_max, guests, amenities, free_cancellation)
     VALUES
       ($1, 'search', true, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
     RETURNING id`,
    [
      userId,
      searchUrl,
      JSON.stringify(Object.fromEntries(new URL(searchUrl).searchParams)),
      parsed.location || null,
      parsed.check_in || null,
      parsed.check_out || null,
      parsed.ne_lat || null,
      parsed.ne_long || null,
      parsed.sw_lat || null,
      parsed.sw_long || null,
      parsed.price_min || null,
      parsed.price_max || null,
      parsed.guests || null,
      JSON.stringify(parsed.amenities || []),
      parsed.free_cancellation || false,
    ]
  );
  return res.rows[0].id;
}

async function pickCandidateListing(alertId) {
  const res = await query(
    `SELECT l.listing_id, l.price
     FROM search_results sr
     JOIN listings l ON l.listing_id = sr.listing_id
     WHERE sr.search_alert_id = $1
       AND l.price IS NOT NULL
     ORDER BY sr.detected_at DESC
     LIMIT 1`,
    [alertId]
  );
  return res.rows[0] || null;
}

async function main() {
  const testSearchUrl = process.env.TEST_SEARCH_URL;
  const keepData = process.env.KEEP_TEST_DATA === '1';
  const sendRealEmail = process.env.SEND_REAL_EMAIL === '1';
  const useRealICal = process.env.E2E_USE_ICAL === '1';
  const maxResults = Math.max(5, parseInt(process.env.E2E_MAX_RESULTS || '30', 10) || 30);

  if (!testSearchUrl) {
    fail('Missing TEST_SEARCH_URL env var. Provide a real Airbnb search URL.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(testSearchUrl);
  } catch {
    fail('TEST_SEARCH_URL is not a valid URL.');
  }
  if (!parsedUrl.hostname.endsWith('airbnb.com')) {
    fail('TEST_SEARCH_URL must be an airbnb.com URL.');
  }

  const email = process.env.TEST_ALERT_EMAIL || `e2e+${Date.now()}@example.com`;
  const ids = { userId: null, alertId: null };
  const startedAt = new Date();

  try {
    // Avoid queue side effects while importing scraper-worker in this script.
    process.env.WORKER_AUTOSTART = 'false';
    const { runSearchAlert } = await import('../src/workers/scraper-worker.js');

    console.log('0/8 Ensuring DB ID sequences are in sync...');
    await syncCommonSequences();
    console.log('   sequence sync complete');

    console.log('1/8 Creating disposable premium test user...');
    const user = await createTestUser(email);
    ids.userId = user.id;
    console.log(`   user_id=${user.id} email=${user.email}`);

    console.log('2/8 Creating search alert from TEST_SEARCH_URL...');
    const alertId = await createSearchAlert(user.id, testSearchUrl);
    ids.alertId = alertId;
    console.log(`   alert_id=${alertId}`);

    const mockSendEmail = async () => ({ success: true, dryRun: true });
    const sendEmailFn = sendRealEmail ? undefined : mockSendEmail;
    const checkICalFn = useRealICal ? undefined : async () => true;
    const limitedSearchFn = async (params) => {
      const rows = await searchAirbnb(params);
      return (rows || []).slice(0, maxResults);
    };

    const tracedDbQuery = async (sql, params = []) => {
      try {
        return await query(sql, params);
      } catch (e) {
        console.error('\nDB query failed inside runSearchAlert:');
        console.error(sql);
        console.error('params:', params);
        throw e;
      }
    };

    console.log('3/8 Running alert first time (baseline scrape)...');
    const run1Opts = { dbQuery: tracedDbQuery };
    run1Opts.searchFn = limitedSearchFn;
    if (sendEmailFn) run1Opts.sendEmailFn = sendEmailFn;
    if (checkICalFn) run1Opts.checkICalFn = checkICalFn;
    const run1 = await runSearchAlert(alertId, run1Opts);
    console.log('   run1:', run1);
    if (run1.status !== 'success') {
      fail(`First run failed: ${JSON.stringify(run1)}`);
    }
    if (run1.totalListings === 0) {
      fail('First run returned zero listings. Use a broader TEST_SEARCH_URL and retry.');
    }

    console.log('4/8 Picking a listing with a current numeric price...');
    const candidate = await pickCandidateListing(alertId);
    if (!candidate) {
      fail('No priced listing found in baseline results. Try a different TEST_SEARCH_URL.');
    }
    const listingId = candidate.listing_id;
    const currentPrice = Number(candidate.price);
    if (!Number.isFinite(currentPrice)) {
      fail(`Listing ${listingId} has invalid current price: ${candidate.price}`);
    }
    console.log(`   listing_id=${listingId} current_price=${currentPrice}`);

    const forcedOldPrice = Math.round(currentPrice + Math.max(50, currentPrice * 0.25));
    console.log(`5/8 Forcing old baseline price for deterministic drop: ${forcedOldPrice} -> ${currentPrice}`);

    // Make forcedOldPrice the latest known baseline for this listing+alert.
    // If we append it in the past, newer rows from run1 will still win and no
    // drop will be detected, so replace that listing's history slice.
    await query(
      `DELETE FROM listing_price_history
       WHERE listing_id = $1 AND search_alert_id = $2`,
      [listingId, alertId]
    );
    await query(
      `INSERT INTO listing_price_history (listing_id, search_alert_id, price, recorded_at)
       VALUES ($1, $2, $3, NOW())`,
      [listingId, alertId, forcedOldPrice]
    );

    // Ensure dedupe window doesn't block this test for the chosen listing.
    await query(
      `DELETE FROM notifications
       WHERE search_alert_id = $1
         AND listing_id = $2
         AND notification_type = 'price_drop'`,
      [alertId, listingId]
    );

    console.log('6/8 Running alert second time (should detect price_drop)...');
    const run2Opts = { dbQuery: tracedDbQuery };
    run2Opts.searchFn = limitedSearchFn;
    if (sendEmailFn) run2Opts.sendEmailFn = sendEmailFn;
    if (checkICalFn) run2Opts.checkICalFn = checkICalFn;
    const run2 = await runSearchAlert(alertId, run2Opts);
    console.log('   run2:', run2);
    if (run2.status !== 'success') {
      fail(`Second run failed: ${JSON.stringify(run2)}`);
    }

    console.log('7/8 Verifying notifications row + payload...');
    const notifRes = await query(
      `SELECT id, notification_type, email_sent, email_error, sent_at, payload
       FROM notifications
       WHERE search_alert_id = $1
         AND listing_id = $2
         AND notification_type = 'price_drop'
         AND sent_at >= $3
       ORDER BY sent_at DESC
       LIMIT 1`,
      [alertId, listingId, startedAt.toISOString()]
    );

    if (notifRes.rows.length === 0) {
      fail('No price_drop notification row found after second run.');
    }

    const notif = notifRes.rows[0];
    const payload = notif.payload || {};

    console.log('\n✅ PASS: end-to-end worker + notification pipeline verified');
    console.log(`   notification_id=${notif.id}`);
    console.log(`   notification_type=${notif.notification_type}`);
    console.log(`   email_sent=${notif.email_sent}`);
    console.log(`   email_error=${notif.email_error || '(none)'}`);
    console.log(`   payload.listing.id=${payload.listing?.id || '(missing)'}`);
    console.log(`   payload.prices.old_price=${payload.prices?.old_price ?? '(missing)'}`);
    console.log(`   payload.prices.new_price=${payload.prices?.new_price ?? '(missing)'}`);

    if (!keepData) {
      console.log('8/8 Cleaning up disposable test rows...');
      await cleanup(ids);
      console.log('Cleanup complete.');
    } else {
      console.log('8/8 KEEP_TEST_DATA=1 set; leaving test rows in DB for inspection.');
      console.log(`Inspect with user_id=${ids.userId}, alert_id=${ids.alertId}, listing_id=${listingId}`);
    }

    if (!keepData) {
      await syncCommonSequences();
    }
  } catch (err) {
    console.error(`\n❌ FAIL: ${err.message || err}`);
    if (!keepData) {
      try {
        await cleanup(ids);
      } catch {
        // best-effort cleanup
      }
    }
    process.exit(1);
  }
}

main();
