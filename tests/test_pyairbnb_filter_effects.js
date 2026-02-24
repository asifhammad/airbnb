#!/usr/bin/env node
import { searchAirbnb } from '../src/workers/python-executor.js';

const paramsBase = {
  check_in: '2026-03-03',
  check_out: '2026-03-10',
  ne_lat: 43.8554425,
  ne_long: -79.1132193,
  sw_lat: 43.5796082,
  sw_long: -79.6392832,
  price_min: null,
  price_max: 404,
  guests: 2,
  amenities: [51,33,8,5],
  currency: 'USD'
};

(async () => {
  try {
    console.log('Running search without min_beds...');
    const res1 = await searchAirbnb(paramsBase);
    console.log('Result count:', res1.length);

    console.log('\nRunning search with min_beds=1...');
    const res2 = await searchAirbnb(Object.assign({}, paramsBase, { min_beds: 1 }));
    console.log('Result count:', res2.length);

    console.log('\nSample 1 result keys (first item):');
    if (res1.length) console.log(Object.keys(res1[0]));
    console.log('\nSample 2 result keys (first item):');
    if (res2.length) console.log(Object.keys(res2[0]));
  } catch (err) {
    console.error('Error during test:', err.message || err);
    process.exitCode = 1;
  }
})();