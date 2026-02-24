#!/usr/bin/env node
import parse from '../src/utils/parseSearchUrl.js';
import axios from 'axios';
import { searchAirbnb } from '../src/workers/python-executor.js';

async function geocodeIfNeeded(parsed) {
  if (parsed.ne_lat && parsed.sw_lat) return parsed;
  try {
    const q = encodeURIComponent(parsed.location);
    const geoRes = await axios.get(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, { headers: { 'User-Agent': 'airbnb-alerts/1.0' }, timeout: 5000 });
    const hit = geoRes.data[0];
    if (hit && hit.boundingbox) {
      const [south, north, west, east] = hit.boundingbox.map(Number);
      parsed.ne_lat = north; parsed.ne_long = east; parsed.sw_lat = south; parsed.sw_long = west;
    }
  } catch (e) {
    console.warn('Geocoding failed, proceeding without bbox:', e.message || e);
  }
  // Fallback bbox for Toronto when geocoding fails (keeps tests deterministic)
  if (!parsed.ne_lat && parsed.location && /toronto/i.test(parsed.location)) {
    parsed.ne_lat = 43.8554425; parsed.ne_long = -79.1132193; parsed.sw_lat = 43.5796082; parsed.sw_long = -79.6392832;
  }
  return parsed;
}

function sampleResults(results, n = 5) {
  return (results || []).slice(0, n).map(r => ({ id: r.id, name: r.name, price: r.price, badges: r.badges || [] }));
}

(async function main(){
  const url = `https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=filter_change&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true`;

  const parsed = parse(url);
  console.log('Parsed filters:', parsed);

  await geocodeIfNeeded(parsed);
  console.log('Using bbox:', parsed.ne_lat, parsed.ne_long, parsed.sw_lat, parsed.sw_long);

  const base = {
    check_in: parsed.check_in,
    check_out: parsed.check_out,
    ne_lat: parsed.ne_lat,
    ne_long: parsed.ne_long,
    sw_lat: parsed.sw_lat,
    sw_long: parsed.sw_long,
    guests: parsed.guests || 1,
    price_min: parsed.price_min || null,
    price_max: parsed.price_max || null,
    amenities: parsed.amenities || [],
    min_beds: parsed.min_beds || null,
    currency: 'USD',
    refinement_paths: parsed.refinement_paths || []
  };

  const cases = [
    { name: 'full (URL-driven)', params: Object.assign({}, base, parsed) },
    { name: 'no weekly', params: Object.assign({}, base, Object.assign({}, parsed, { price_filter_num_nights: null, flexible_trip_lengths: [] })) },
    { name: 'no monthly', params: Object.assign({}, base, Object.assign({}, parsed, { monthly_start_date: null, monthly_length: null, monthly_end_date: null })) },
    { name: 'no guest_favorite', params: Object.assign({}, base, Object.assign({}, parsed, { guest_favorite: false })) },
    { name: 'no instant_book', params: Object.assign({}, base, Object.assign({}, parsed, { instant_book: false, ib: null })) },
    { name: 'no min_beds', params: Object.assign({}, base, Object.assign({}, parsed, { min_beds: null })) },
    { name: 'minimal (bbox + dates)', params: base }
  ];

  for (const c of cases) {
    try {
      console.log('\n--- Test case:', c.name);
      const results = await searchAirbnb(c.params);
      console.log('  Total results:', (results && results.length) || 0);
      console.log('  Sample:', sampleResults(results, 5));
    } catch (err) {
      console.error('  Error for case', c.name, err && err.message || err);
    }
  }
})();
