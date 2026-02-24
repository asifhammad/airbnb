#!/usr/bin/env node
import parse from '../src/utils/parseSearchUrl.js';
import axios from 'axios';
import { searchAirbnb } from '../src/workers/python-executor.js';

(async function main(){
  try {
    const url = `https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=filter_change&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true`;

    const parsed = parse(url);
    console.log('Parsed filters:', parsed);

    // Geocode if bounding box missing
    if (!parsed.ne_lat || !parsed.sw_lat) {
      const q = encodeURIComponent(parsed.location);
      const geoRes = await axios.get(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, { headers: { 'User-Agent': 'airbnb-alerts/1.0' }, timeout: 5000 });
      const hit = geoRes.data[0];
      if (hit && hit.boundingbox) {
        const [south, north, west, east] = hit.boundingbox.map(Number);
        parsed.ne_lat = north; parsed.ne_long = east; parsed.sw_lat = south; parsed.sw_long = west;
        console.log('Geocoded bbox:', parsed.ne_lat, parsed.ne_long, parsed.sw_lat, parsed.sw_long);
      }
    }

    // Pass the full parsed URL params to the Python scraper so it can
    // honor URL-specific filters (weekly/monthly/ib/guest_favorite/min_beds).
    const pyParams = Object.assign({ currency: 'USD' }, parsed);

    console.log('Calling pyairbnb.search_all with parsed URL params...');
    const results = await searchAirbnb(pyParams);
    console.log('pyairbnb returned', results.length, 'listings');
    if (results.length > 0) console.log('Sample result id:', results[0].get ? results[0].get('id') : results[0].id || results[0].room_id || results[0].listingId || 'N/A');
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exitCode = 1;
  }
})();