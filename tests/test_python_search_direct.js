#!/usr/bin/env node
// Direct test of Python search script with Toronto URL parameters
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import parseSearchUrl from '../src/utils/parseSearchUrl.js';

const url = 'https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=user_map_move&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true&ne_lat=49.78399555676937&ne_lng=-71.16777996437563&sw_lat=37.05007652576309&sw_lng=-87.52316428221945&zoom=5.62079895446209&zoom_level=5.62079895446209&search_by_map=true';

const parsed = parseSearchUrl(url);

// Prepare parameters for Python script
const pyParams = {
  check_in: parsed.check_in,
  check_out: parsed.check_out,
  ne_lat: parsed.ne_lat,
  ne_long: parsed.ne_long,
  sw_lat: parsed.sw_lat,
  sw_long: parsed.sw_long,
  zoom: parsed.zoom || parsed.zoom_level, // KEY: Use the actual zoom from URL
  price_min: parsed.price_min || 0,
  price_max: parsed.price_max || 0,
  adults: parsed.guests || 2,
  infants: parsed.infants || 0,
  amenities: parsed.amenities || [],
  min_beds: parsed.min_beds || null,
  guest_favorite: parsed.guest_favorite || false,
  instant_book: parsed.instant_book || false,
  monthly_start_date: parsed.monthly_start_date || null,
  monthly_length: parsed.monthly_length || null,
  monthly_end_date: parsed.monthly_end_date || null,
  price_filter_num_nights: parsed.price_filter_num_nights || null,
  flexible_trip_lengths: parsed.flexible_trip_lengths || [],
  refinement_paths: parsed.refinement_paths || [],
  search_by_map: parsed.search_by_map || false,
  search_type: parsed.search_type || null,
  monthly_search: parsed.monthly_search || false,
  currency: 'USD',
  proxy_url: ''
};

console.log('=== Testing Python search with zoom parameter ===');
console.log('Zoom value being passed:', pyParams.zoom);
console.log('(Previously this was hardcoded to 10)');

// Create temp file for input (using already imported fs/path/crypto modules)

const tempId = randomBytes(4).toString('hex');
const inputFile = join('/tmp', `search_test_${tempId}.json`);
const outputFile = join('/tmp', `search_result_${tempId}.json`);

try {
  writeFileSync(inputFile, JSON.stringify(pyParams));
  
  console.log('\nRunning Python search script...');
  
  const pythonProcess = spawn('python3', [
    'src/python/search_listings.py',
    inputFile,
    outputFile
  ], {
    cwd: process.cwd(),
    env: process.env
  });

  let stderr = '';
  pythonProcess.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  pythonProcess.on('close', (code) => {
    try {
      unlinkSync(inputFile);
      
      if (code !== 0) {
        console.error('Python script failed with exit code', code);
        console.error('stderr:', stderr);
        return;
      }

      const output = readFileSync(outputFile, 'utf-8');
      unlinkSync(outputFile);
      
      const result = JSON.parse(output);
      
      console.log('\n=== Search Results ===');
      console.log(`Total listings found: ${result.length || result.results?.length || 0}`);
      
      if (Array.isArray(result) && result.length > 0) {
        console.log('\nFirst 3 listings:');
        result.slice(0, 3).forEach((listing, i) => {
          console.log(`\n${i + 1}. ${listing.name || listing.title || 'Unnamed'}`);
          console.log(`   ID: ${listing.id}`);
          console.log(`   Price: ${listing.price?.unit?.amount || listing.price || 'N/A'}`);
          console.log(`   Location: lat=${listing.lat || listing.location?.lat}, lng=${listing.lng || listing.location?.lng}`);
          console.log(`   Room type: ${listing.room_type || listing.type || 'N/A'}`);
          console.log(`   Beds: ${listing.beds || listing.bedrooms || 'N/A'}`);
        });
      } else if (result.results) {
        console.log(`Results from wrapper: ${result.results.length} listings`);
      } else {
        console.log('Unexpected result format:', result);
      }
    } catch (error) {
      console.error('Error processing results:', error);
    }
  });
} catch (error) {
  console.error('Error:', error.message);
}
