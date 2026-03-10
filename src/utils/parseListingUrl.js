// Utility to parse Airbnb listing/search URLs and extract useful parameters
import { isAirbnbHostname } from './isAirbnbHostname.js';

export function parseListingUrl(urlString) {
  try {
    const url = new URL(urlString);

    // only accept airbnb domains
    if (!isAirbnbHostname(url.hostname)) return null;

    const parts = url.pathname.split('/').filter(Boolean);

    // common pattern: /rooms/{listingId}
    let listingId = null;
    const roomIdx = parts.indexOf('rooms');
    if (roomIdx !== -1 && parts.length > roomIdx + 1) {
      listingId = parts[roomIdx + 1];
    } else {
      // fallback: pick first purely-numeric segment
      const numeric = parts.find(p => /^\d+$/.test(p));
      if (numeric) listingId = numeric;
    }

    const params = Object.fromEntries(url.searchParams.entries());

    return {
      listingId: listingId || null,
      check_in: params.check_in || null,
      check_out: params.check_out || null,
      rawParams: params
    };
  } catch (err) {
    return null;
  }
}

export default parseListingUrl;
