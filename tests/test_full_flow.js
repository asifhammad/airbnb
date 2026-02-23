#!/usr/bin/env node
// Test the full parameter flow from URL parsing to Python search parameters
import parseSearchUrl from '../src/utils/parseSearchUrl.js';

const url = 'https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=user_map_move&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true&ne_lat=49.78399555676937&ne_lng=-71.16777996437563&sw_lat=37.05007652576309&sw_lng=-87.52316428221945&zoom=5.62079895446209&zoom_level=5.62079895446209&search_by_map=true';

console.log('=== URL Parsing ===');
const parsed = parseSearchUrl(url);
console.log('Parsed parameters:');
console.log(JSON.stringify(parsed, null, 2));

console.log('\n=== Parameters that should be passed to Python ===');
const pythonParams = {
  check_in: parsed.check_in,
  check_out: parsed.check_out,
  ne_lat: parsed.ne_lat,
  ne_long: parsed.ne_long,
  sw_lat: parsed.sw_lat,
  sw_long: parsed.sw_long,
  zoom: parsed.zoom || parsed.zoom_level,
  price_min: parsed.price_min,
  price_max: parsed.price_max,
  adults: parsed.guests, // Note: guests includes adults+children
  infants: parsed.infants,
  amenities: parsed.amenities,
  min_beds: parsed.min_beds,
  guest_favorite: parsed.guest_favorite,
  instant_book: parsed.instant_book,
  monthly_start_date: parsed.monthly_start_date,
  monthly_length: parsed.monthly_length,
  monthly_end_date: parsed.monthly_end_date,
  price_filter_num_nights: parsed.price_filter_num_nights,
  flexible_trip_lengths: parsed.flexible_trip_lengths,
  refinement_paths: parsed.refinement_paths,
  search_by_map: parsed.search_by_map,
  search_type: parsed.search_type,
  monthly_search: parsed.monthly_search
};

console.log(JSON.stringify(pythonParams, null, 2));

console.log('\n=== Key differences from previous implementation ===');
console.log('- zoom: now uses parsed value (5.62) instead of hardcoded 10');
console.log('- zoom_level: also available as fallback');
console.log('- search_by_map: true (indicates map-based search)');
console.log('- search_type: user_map_move (specific search trigger)');
console.log('- These parameters should affect the search area and results');
