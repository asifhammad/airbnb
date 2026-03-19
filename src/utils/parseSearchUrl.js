// Parse an Airbnb search URL and extract commonly-used filters
// Returns an object mapping to the application's search_alerts columns plus rawParams
import { isAirbnbHostname } from './isAirbnbHostname.js';

export function parseSearchUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (!isAirbnbHostname(url.hostname)) return null;

    const sp = url.searchParams;

    // helper to read integer params
    const asInt = (v) => {
      if (!v) return null;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    };

    // guests: prefer adults+children, fall back to guests param
    const adults = asInt(sp.get('adults')) || 0;
    const children = asInt(sp.get('children')) || 0;
    const infants = asInt(sp.get('infants')) || 0;
    const guests = (adults + children) || asInt(sp.get('guests')) || null;

    // amenities may be provided as amenities[] or amenities
    const amenities = sp.getAll('amenities[]').length ? sp.getAll('amenities[]') : sp.getAll('amenities');
    const amenitiesNorm = amenities.map(a => (a && !isNaN(a) ? parseInt(a, 10) : a)).filter(Boolean);

    // price
    const price_min = asInt(sp.get('price_min')) || null;
    const price_max = asInt(sp.get('price_max')) || asInt(sp.get('price_max_input')) || null;
    const currency = sp.get('currency') ? String(sp.get('currency')).toUpperCase() : null;

    // bounding box / map viewport (Airbnb sometimes encodes as ne_lat/ne_lng etc.)
    const ne_lat = sp.get('ne_lat') || sp.get('ne_latitude') || null;
    const ne_long = sp.get('ne_long') || sp.get('ne_lng') || sp.get('ne_longitude') || null;
    const sw_lat = sp.get('sw_lat') || sp.get('sw_latitude') || null;
    const sw_long = sp.get('sw_long') || sp.get('sw_lng') || sp.get('sw_longitude') || null;

    // other useful filters
    const min_beds = asInt(sp.get('min_beds')) || null;
    const guest_favorite = (sp.get('guest_favorite') === 'true') || (sp.get('guest_favorite') === '1') || null;
    const instant_book = (sp.get('ib') === 'true') || (sp.get('ib') === '1') || null;

    const check_in = sp.get('checkin') || sp.get('check_in') || null;
    const check_out = sp.get('checkout') || sp.get('check_out') || null;

    const location = sp.get('query') || decodeURIComponent((url.pathname || '').replace(/^\/s\//, '').replace(/--/g, ', ')) || null;
    const place_id = sp.get('place_id') || null;

    const refinement_paths = sp.getAll('refinement_paths[]').length ? sp.getAll('refinement_paths[]') : sp.getAll('refinement_paths');
    const monthly_start_date = sp.get('monthly_start_date') || null;
    const monthly_length = asInt(sp.get('monthly_length')) || null;
    let monthly_end_date = sp.get('monthly_end_date') || null;

    // map/zoom parameters
    const zoom = sp.get('zoom') ? parseFloat(sp.get('zoom')) : null;
    const zoom_level = sp.get('zoom_level') ? parseFloat(sp.get('zoom_level')) : null;
    const search_by_map = (sp.get('search_by_map') === 'true') || (sp.get('search_by_map') === '1') || null;
    const search_type = sp.get('search_type') || null;

    // Normalize monthly_end_date: when monthly_start_date + monthly_length is
    // provided we treat monthly_length as a count of full months and compute
    // an inclusive end date = add(monthly_start_date, monthly_length) - 1 day.
    // Airbnb's URL sometimes encodes the exclusive end (start + length) which
    // can be confusing — return the normalized inclusive end date instead.
    if (monthly_start_date && monthly_length) {
      try {
        const parts = monthly_start_date.split('-').map(Number);
        if (parts.length === 3) {
          const d = new Date(parts[0], parts[1] - 1, parts[2]);
          // add months
          const end = new Date(d.getFullYear(), d.getMonth() + monthly_length, d.getDate());
          // subtract one day to make the end date inclusive
          end.setDate(end.getDate() - 1);
          const yyyy = end.getFullYear();
          const mm = String(end.getMonth() + 1).padStart(2, '0');
          const dd = String(end.getDate()).padStart(2, '0');
          monthly_end_date = `${yyyy}-${mm}-${dd}`;
        }
      } catch (e) {
        // leave monthly_end_date as provided if parsing fails
      }
    }
  const price_filter_num_nights = asInt(sp.get('price_filter_num_nights')) || null;

    return {
      location,
      place_id,
      check_in,
      check_out,
      guests,
      infants: infants || null,
      price_min,
      price_max,
      currency,
      amenities: amenitiesNorm,
      min_beds,
      guest_favorite,
      instant_book,
      monthly_search: !!(monthly_start_date || monthly_length),
      monthly_start_date: monthly_start_date || null,
      monthly_length: monthly_length || null,
      monthly_end_date: monthly_end_date || null,
      price_filter_num_nights: price_filter_num_nights || null,
      ne_lat: ne_lat ? parseFloat(ne_lat) : null,
      ne_long: ne_long ? parseFloat(ne_long) : null,
      sw_lat: sw_lat ? parseFloat(sw_lat) : null,
      sw_long: sw_long ? parseFloat(sw_long) : null,
      refinement_paths: refinement_paths || [],
      zoom: zoom,
      zoom_level: zoom_level,
      search_by_map: search_by_map,
      search_type: search_type,
      rawParams: Object.fromEntries(sp.entries())
    };
  } catch (err) {
    return null;
  }
}

export default parseSearchUrl;
