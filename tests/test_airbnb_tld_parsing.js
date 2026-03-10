#!/usr/bin/env node
import assert from 'node:assert/strict';
import parseSearchUrl from '../src/utils/parseSearchUrl.js';
import parseListingUrl from '../src/utils/parseListingUrl.js';

const searchUrl = 'https://www.airbnb.ca/s/Toronto--Canada/homes?checkin=2026-03-10&checkout=2026-03-12';
const listingUrl = 'https://www.airbnb.fr/rooms/12345678?check_in=2026-03-10&check_out=2026-03-12';
const ukSearchUrl = 'https://www.airbnb.co.uk/s/London--UK/homes?checkin=2026-03-10&checkout=2026-03-12';
const invalidUrl = 'https://airbnb.evil.com/s/Paris--France/homes?checkin=2026-03-10&checkout=2026-03-12';

const parsedSearch = parseSearchUrl(searchUrl);
assert.ok(parsedSearch, 'Expected parseSearchUrl to accept airbnb.ca URLs');

const parsedListing = parseListingUrl(listingUrl);
assert.equal(parsedListing?.listingId, '12345678', 'Expected parseListingUrl to extract listing id from airbnb.fr');

const parsedUkSearch = parseSearchUrl(ukSearchUrl);
assert.ok(parsedUkSearch, 'Expected parseSearchUrl to accept airbnb.co.uk URLs');

const parsedInvalid = parseSearchUrl(invalidUrl);
assert.equal(parsedInvalid, null, 'Expected parseSearchUrl to reject non-Airbnb domains');

console.log('✅ Airbnb TLD parsing checks passed.');
