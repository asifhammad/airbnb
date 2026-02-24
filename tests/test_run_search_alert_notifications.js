#!/usr/bin/env node
import assert from 'assert';
import { runSearchAlert } from '../src/workers/scraper-worker.js';

async function main() {
  const alertId = 123;
  const knownListingId = 'known-listing-1';
  const newListingId = 'new-listing-2';

  const sentEmails = [];
  const notificationWrites = [];

  const mockDbQuery = async (sql, params = []) => {
    if (sql.includes('SELECT * FROM search_alerts WHERE id = $1 AND is_active = true')) {
      return {
        rows: [{
          id: alertId,
          user_id: 77,
          is_active: true,
          check_in: '2026-03-10',
          check_out: '2026-03-12',
          search_url: 'https://www.airbnb.com/s/test',
          url_params: null,
          price_min: null,
          price_max: null,
          guests: 2,
          amenities: [],
          free_cancellation: false,
          instant_book: false,
          guest_favorite: false,
          min_beds: null,
          infants: null,
          location: 'Test City',
        }],
      };
    }

    if (sql.includes('WITH known_ids AS')) {
      return {
        rows: [{ listing_id: knownListingId, last_price: 500 }],
      };
    }

    if (sql.includes('FROM notifications') && sql.includes("notification_type = 'price_drop'")) {
      return { rows: [] };
    }

    if (sql.includes('FROM notifications') && sql.includes("notification_type = 'availability_change'")) {
      return { rows: [] };
    }

    if (sql.includes('SELECT price, recorded_at FROM listing_price_history')) {
      return {
        rows: [
          { price: 500, recorded_at: '2026-02-22T00:00:00.000Z' },
          { price: 300, recorded_at: '2026-02-23T00:00:00.000Z' },
        ],
      };
    }

    if (sql.includes('SELECT u.email, u.subscription_tier FROM users u')) {
      return { rows: [{ email: 'test@example.com', subscription_tier: 'premium' }] };
    }

    if (sql.includes('INSERT INTO notifications')) {
      notificationWrites.push({ sql, params });
      return { rowCount: 1, rows: [] };
    }

    return { rows: [], rowCount: 1 };
  };

  const mockSearchFn = async () => ([
    {
      id: knownListingId,
      url: 'https://www.airbnb.com/rooms/111',
      name: 'Known listing',
      price: 300,
      currency: 'USD',
      rating: 4.8,
      reviewsCount: 50,
      roomType: 'Entire home',
      guests: 2,
      beds: 1,
      bedrooms: 1,
      address: '1 Test Street',
    },
    {
      id: newListingId,
      url: 'https://www.airbnb.com/rooms/222',
      name: 'New listing',
      price: 220,
      currency: 'USD',
      rating: 4.7,
      reviewsCount: 20,
      roomType: 'Entire home',
      guests: 2,
      beds: 1,
      bedrooms: 1,
      address: '2 Test Street',
    },
  ]);

  const mockCheckICalFn = async () => true;

  const mockSendEmailFn = async (_userEmail, _alert, listings, opts = {}) => {
    sentEmails.push({ type: opts.type, listingIds: listings.map(l => l.id) });
    return { success: true };
  };

  const result = await runSearchAlert(alertId, {
    searchFn: mockSearchFn,
    checkICalFn: mockCheckICalFn,
    sendEmailFn: mockSendEmailFn,
    dbQuery: mockDbQuery,
  });

  assert.equal(result.status, 'success');
  assert.equal(result.newListings, 1);
  assert.equal(result.priceDrops, 1);
  assert.equal(result.freedUp, 1);

  const typesSent = sentEmails.map(e => e.type).sort();
  assert.deepEqual(typesSent, ['availability', 'new', 'price_drop']);

  const notifTypes = notificationWrites.map(w => w.params[2]).sort();
  assert.deepEqual(notifTypes, ['availability_change', 'new_listing', 'price_drop']);

  console.log('✅ runSearchAlert sends premium notifications for new, price_drop, and availability_change');
}

main().catch((err) => {
  console.error('❌ Test failed:', err.message || err);
  process.exit(1);
});
