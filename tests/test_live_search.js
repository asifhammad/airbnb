#!/usr/bin/env node
// Test live search with the Toronto URL
import parseSearchUrl from '../src/utils/parseSearchUrl.js';

const url = 'https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=user_map_move&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true&ne_lat=49.78399555676937&ne_lng=-71.16777996437563&sw_lat=37.05007652576309&sw_lng=-87.52316428221945&zoom=5.62079895446209&zoom_level=5.62079895446209&search_by_map=true';

const parsed = parseSearchUrl(url);

// Prepare search parameters for API call
const searchParams = {
  // Use the parsed bounding box
  ne_lat: parsed.ne_lat,
  ne_long: parsed.ne_long,
  sw_lat: parsed.sw_lat,
  sw_long: parsed.sw_long,
  // Dates
  check_in: parsed.check_in,
  check_out: parsed.check_out,
  // Guests
  adults: parsed.guests,
  infants: parsed.infants,
  // Filters
  price_max: parsed.price_max,
  amenities: parsed.amenities,
  min_beds: parsed.min_beds,
  guest_favorite: parsed.guest_favorite,
  instant_book: parsed.instant_book,
  // Map/zoom parameters (these are the key fixes!)
  zoom: parsed.zoom,
  zoom_level: parsed.zoom_level,
  search_by_map: parsed.search_by_map,
  search_type: parsed.search_type,
  // Monthly parameters
  monthly_start_date: parsed.monthly_start_date,
  monthly_length: parsed.monthly_length,
  monthly_end_date: parsed.monthly_end_date,
  price_filter_num_nights: parsed.price_filter_num_nights,
  flexible_trip_lengths: parsed.flexible_trip_lengths,
  refinement_paths: parsed.refinement_paths
};

console.log('Calling search API with parameters:');
console.log(JSON.stringify(searchParams, null, 2));

try {
  const response = await fetch('/api/listings/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Add auth token if needed - check if you're logged in
    },
    body: JSON.stringify(searchParams)
  });

  const data = await response.json();
  
  console.log('\n=== Search Results ===');
  console.log(`Status: ${response.status}`);
  console.log(`Total results: ${data.listings ? data.listings.length : 0}`);
  
  if (data.listings && data.listings.length > 0) {
    console.log('\nFirst few listings:');
    data.listings.slice(0, 5).forEach((listing, i) => {
      console.log(`\n${i + 1}. ${listing.name || listing.title || 'Unnamed'}`);
      console.log(`   ID: ${listing.id}`);
      console.log(`   Price: ${listing.price}`);
      console.log(`   Location: ${listing.lat}, ${listing.lng}`);
      console.log(`   Room type: ${listing.room_type || listing.type}`);
      console.log(`   Beds: ${listing.beds || listing.bedrooms || 'N/A'}`);
      console.log(`   Guest favorite: ${listing.is_guest_favorite || listing.badges?.includes?.('GUEST_FAVORITE') ? 'Yes' : 'No'}`);
      console.log(`   Instant book: ${listing.instant_book || listing.ib || 'No'}`);
    });
  } else {
    console.log('No listings found or error:', data);
  }
} catch (error) {
  console.error('Error calling search API:', error.message);
  console.log('\nNote: Make sure you are logged in and the server is running on localhost:3000');
}
