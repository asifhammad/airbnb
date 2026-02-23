#!/usr/bin/env node
import { searchAirbnb } from '../src/workers/python-executor.js';

(async () => {
  try {
    const params = {
      check_in: '2026-03-03',
      check_out: '2026-03-10',
      ne_lat: 43.8554425, ne_long: -79.1132193, sw_lat: 43.5796082, sw_long: -79.6392832,
      price_min: null, price_max: 404, guests: 2, amenities: [51,33,8,5], currency: 'USD'
    };

    const results = await searchAirbnb(params);
    console.log('pyairbnb returned', results.length, 'results');

    const wantGuestFavorite = true; // from URL
    const wantInstantBook = true;   // from URL
    const minBeds = 1;              // from URL

    const filtered = results
      .filter(r => (!wantGuestFavorite || r.isGuestFavorite))
      .filter(r => (!wantInstantBook || r.instantBook))
      .filter(r => (!minBeds || ((r.beds || r.bedrooms || 0) >= minBeds)));

    console.log('After applying guest_favorite + ib + min_beds filters ->', filtered.length);
    console.log('Sample badges for first 10 filtered entries:', filtered.slice(0,10).map(r => ({ id: r.id, badges: r.badges, beds: r.beds, bedrooms: r.bedrooms })));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
})();