#!/usr/bin/env node
import parse from '../src/utils/parseSearchUrl.js';
import { searchAirbnb } from '../src/workers/python-executor.js';

(async () => {
  const url = `https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=filter_change&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true`;
  const parsed = parse(url);
  parsed.ne_lat = parsed.ne_lat || 43.8554425; parsed.ne_long = parsed.ne_long || -79.1132193; parsed.sw_lat = parsed.sw_lat || 43.5796082; parsed.sw_long = parsed.sw_long || -79.6392832;
  const params = { check_in: parsed.check_in, check_out: parsed.check_out, ne_lat: parsed.ne_lat, ne_long: parsed.ne_long, sw_lat: parsed.sw_lat, sw_long: parsed.sw_long, price_min: parsed.price_min || null, price_max: parsed.price_max || null, guests: parsed.guests || 1, amenities: parsed.amenities || [], currency: 'USD' };
  const results = await searchAirbnb(params);
  console.log('Total results:', results.length);

  const centerLat = (parsed.ne_lat + parsed.sw_lat) / 2;
  const centerLng = (parsed.ne_long + parsed.sw_long) / 2;
  const latExtent = (parsed.ne_lat - parsed.sw_lat);
  const lngExtent = (parsed.ne_long - parsed.sw_long);

  for (const factor of [1, 0.5, 0.25, 0.1, 0.05]) {
    const halfLat = (latExtent * factor) / 2;
    const halfLng = (lngExtent * factor) / 2;
    const count = results.filter(r => {
      if (!r.lat || !r.lng) return false;
      return Math.abs(r.lat - centerLat) <= halfLat && Math.abs(r.lng - centerLng) <= halfLng;
    }).length;
    console.log(`factor ${factor} -> ${count} listings within tightened bbox`);
  }
})();