#!/usr/bin/env python3
"""
Search Airbnb listings using pyairbnb library
Usage: python search_listings.py <input_json_file> <output_json_file>
"""

import sys
import json
import re
import os
import pyairbnb

# Ensure src/python is on the path regardless of working directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from airbnb_search import search_from_url

def normalize_place_type(place_type):
    """Normalize place_type labels to match pyairbnb expectations."""
    if not isinstance(place_type, str):
        return place_type
    pt = place_type.strip().lower()
    if pt in ('entire home', 'entire home/apt', 'entire place', 'entire_home', 'entire_home_apt'):
        return 'Entire home/apt'
    if pt in ('private room', 'private_room'):
        return 'Private room'
    if pt in ('shared room', 'shared_room'):
        return 'Shared room'
    return place_type.strip()

def search_listings(params):
    """Search Airbnb listings with given parameters"""
    try:
        currency = params.get('currency', 'USD')
        proxy_url = params.get('proxy_url', '')
        search_url = params.get('search_url', '')

        # ------------------------------------------------------------------ #
        # SEARCH STRATEGY
        #
        # pyairbnb.search_all() has hardcoded rawParams (Galapagos placeId,
        # query, monthlyStartDate=2024, etc.) that corrupt every search
        # regardless of the bbox you pass. The only reliable approach is
        # search_all_from_url() which parses the original Airbnb URL and
        # sends the correct placeId, query, ib, guest_favorite, amenities,
        # min_beds, etc. directly to Airbnb's API — server-side filtering
        # instead of fragile post-filtering.
        # ------------------------------------------------------------------ #

        if search_url:
            print(f'DEBUG: using direct search_from_url with: {search_url[:80]}...')
            results = search_from_url(
                url=search_url,
                currency=currency,
                proxy_url=proxy_url,
            )
            print(f'DEBUG: search_from_url raw_results_count= {len(results) if results else 0}')

        else:
            # Fallback: no search_url stored — use search_all() but fix the
            # zoom so pyairbnb doesn't over-paginate a country-sized area.
            print('DEBUG: no search_url available, falling back to search_all()')

            ne_lat   = params.get('ne_lat')
            ne_long  = params.get('ne_long')
            sw_lat   = params.get('sw_lat')
            sw_long  = params.get('sw_long')
            check_in  = params.get('check_in')
            check_out = params.get('check_out')
            price_min = params.get('price_min', 0)
            price_max = params.get('price_max', 0)
            place_type = normalize_place_type(params.get('place_type', ''))
            amenities = params.get('amenities', [])
            free_cancellation = params.get('free_cancellation', False)
            adults   = params.get('adults', 0)
            children = params.get('children', 0)
            infants  = params.get('infants', 0)
            min_bedrooms = params.get('min_bedrooms', 0)
            min_beds     = params.get('min_beds', 0)
            min_bathrooms = params.get('min_bathrooms', 0)

            # Clamp zoom — raw URL zoom of ~5 causes pyairbnb to paginate
            # a continent worth of tiles and return hundreds of junk results.
            raw_zoom = params.get('zoom') or params.get('zoom_level')
            try:
                raw_zoom = float(raw_zoom) if raw_zoom is not None else None
            except (TypeError, ValueError):
                raw_zoom = None
            has_bbox = ne_lat and ne_long and sw_lat and sw_long
            if raw_zoom is not None and has_bbox:
                zoom = max(12.0, min(raw_zoom, 16.0))
                print(f'DEBUG: zoom clamped from {raw_zoom} → {zoom}')
            else:
                zoom = 12

            results = pyairbnb.search_all(
                check_in=check_in,
                check_out=check_out,
                ne_lat=ne_lat,
                ne_long=ne_long,
                sw_lat=sw_lat,
                sw_long=sw_long,
                zoom_value=zoom,
                price_min=price_min,
                price_max=price_max,
                place_type=place_type,
                amenities=amenities,
                free_cancellation=free_cancellation,
                adults=adults,
                children=children,
                infants=infants,
                min_bedrooms=min_bedrooms,
                min_beds=min_beds,
                min_bathrooms=min_bathrooms,
                currency=currency,
                proxy_url=proxy_url
            )
            print(f'DEBUG: search_all raw_results_count= {len(results) if results else 0}')

        results = results or []

        # ------------------------------------------------------------------ #
        # POST-FILTERS
        #
        # When search_all_from_url is used, the original URL is sent directly
        # to Airbnb's API so ib, amenities, min_beds, refinement_paths are
        # enforced SERVER-SIDE. Do NOT re-filter those here or we'll
        # incorrectly discard valid results whose fields pyairbnb doesn't
        # populate (ib, roomType, etc.).
        #
        # The ONLY filter we must apply ourselves is guest_favorite because
        # Airbnb's API ignores it even when it's in the URL params.
        # ------------------------------------------------------------------ #
        using_url = bool(search_url)

        # monthly search
        if params.get('monthly_search') or (
            params.get('monthly_start_date') and not (params.get('check_in') and params.get('check_out'))
        ):
            print('DEBUG: Applying monthly filter...')
            def is_monthly(item):
                if item.get('long_stay_discount'):
                    return True
                price_obj = item.get('price') or {}
                unit = price_obj.get('unit') or {}
                qualifier = (unit.get('qualifier') or '').lower()
                if 'month' in qualifier or 'mo' in qualifier:
                    return True
                for t in (item.get('name') or '', item.get('title') or '', item.get('summary') or ''):
                    if isinstance(t, str) and re.search(r'\b(month|monthly|long[- ]stay)\b', t, re.I):
                        return True
                return False
            results = [r for r in results if is_monthly(r)]
        # guest_favorite — Airbnb never enforces this server-side even when
        # sent in rawParams, so always post-filter.
        # Badges to match: GUEST_FAVORITE, TOP_X_GUEST_FAVORITE
        if params.get('guest_favorite'):
            def is_guest_fav(item):
                if item.get('is_guest_favorite') or item.get('isGuestFavorite'):
                    return True
                badges = item.get('badges') or []
                if any('GUEST_FAVORITE' in str(b).upper() for b in badges):
                    return True
                return False
            before = len(results)
            results = [r for r in results if is_guest_fav(r)]
            print(f'DEBUG: guest_favorite filter removed {before - len(results)}, kept {len(results)}')

        # room_types — Airbnb often ignores this server-side, so always post-filter
        if using_url and search_url:
            from urllib.parse import urlparse, parse_qs
            url_qs = parse_qs(urlparse(search_url).query)
            requested_room_types = url_qs.get('room_types[]', [])
            def normalize_rt(rt):
                rt = str(rt or '').strip().lower()
                if rt in ('entire home/apt', 'entire home', 'entire place', 'entire_home', 'entire_home_apt'):
                    return 'entire home/apt'
                if rt in ('private room', 'private_room'):
                    return 'private room'
                if rt in ('shared room', 'shared_room'):
                    return 'shared room'
                return rt
            wanted = set(normalize_rt(rt) for rt in requested_room_types)
            def guess_room_type(item):
                # Try explicit fields first
                for field in ('roomType', 'room_type', 'type', 'kind', 'category'):
                    v = item.get(field)
                    if v:
                        return normalize_rt(v)
                # Fallback: parse name/subtitle for room type hints
                name = str(item.get('name') or item.get('title') or '').lower()
                if 'shared room' in name or 'shared bedroom' in name or 'shared bed' in name:
                    return 'shared room'
                if 'private room' in name or 'private bedroom' in name or 'private bed' in name:
                    return 'private room'
                if 'entire home' in name or 'entire place' in name or 'entire apartment' in name or 'entire condo' in name or 'entire villa' in name or 'entire loft' in name or 'entire cottage' in name or 'entire house' in name or 'entire guesthouse' in name:
                    return 'entire home/apt'
                return None
            def matches_room_type(item):
                listing_rt = guess_room_type(item)
                if listing_rt is None:
                    return True  # can't determine — keep it
                return listing_rt in wanted
            before = len(results)
            results = [r for r in results if matches_room_type(r)]
            print(f'DEBUG: room_type filter removed {before - len(results)}, kept {len(results)} (wanted: {wanted})')

        # instant_book — server-side via URL; only post-filter in fallback mode
        if params.get('instant_book') and not using_url:
            def is_instant(item):
                if item.get('ib') or item.get('instant_book') or item.get('is_instant_bookable') or item.get('isInstantBookable'):
                    return True
                badges = item.get('badges') or []
                if any('INSTANT' in str(b).upper() for b in badges):
                    return True
                return False
            before = len(results)
            results = [r for r in results if is_instant(r)]
            print(f'DEBUG: after_instant_book_filter= {len(results)} (removed {before - len(results)})')

        # min_beds — server-side via URL; only post-filter in fallback mode
        want_min_beds = params.get('min_beds') or 0
        if want_min_beds and not using_url:
            def meets_min_beds(item):
                for field in ('beds', 'min_beds', 'bedCount'):
                    val = item.get(field)
                    if val is not None:
                        try: return int(val) >= int(want_min_beds)
                        except: pass
                sc = item.get('structuredContent') or {}
                for arr_key in ('mapPrimaryLine', 'primaryLine'):
                    for entry in (sc.get(arr_key) or []):
                        body = (entry.get('body') if isinstance(entry, dict) else str(entry)) or ''
                        m = re.search(r'(\d+)\s*bed', str(body), re.I)
                        if m:
                            return int(m.group(1)) >= int(want_min_beds)
                return True
            before = len(results)
            results = [r for r in results if meets_min_beds(r)]
            print(f'DEBUG: after_min_beds_filter= {len(results)} (removed {before - len(results)})')

        # ------------------------------------------------------------------ #
        # NORMALISE
        # ------------------------------------------------------------------ #
        formatted_results = []
        for listing in results:
            def pick(*keys):
                for k in keys:
                    v = listing.get(k)
                    if v is not None:
                        return v
                return None

            raw_id = pick('id', 'room_id', 'roomId', 'listingId')
            try:
                listing_id = str(int(raw_id)) if raw_id is not None else None
            except Exception:
                listing_id = str(raw_id) if raw_id is not None else None

            price  = pick('price', 'price_total', 'priceValue')
            photos = pick('photos', 'images') or []

            # rating may be a plain number OR a dict like {'value': 4.87, 'reviewCount': '162'}
            raw_rating = pick('rating', 'stars', 'score')
            if isinstance(raw_rating, dict):
                rating_value = raw_rating.get('value')
                review_count_from_rating = raw_rating.get('reviewCount')
            else:
                rating_value = raw_rating
                review_count_from_rating = None

            lat = lng = None
            loc = pick('location', 'coordinates') or {}
            if isinstance(loc, dict):
                lat = loc.get('lat') or loc.get('latitude')
                lng = loc.get('lng') or loc.get('longitude')

            badges = pick('badges') or []
            structured = listing.get('structuredContent') or {}

            bedrooms = beds = None
            try:
                for entry in (structured.get('mapPrimaryLine') or []):
                    if isinstance(entry, dict) and entry.get('type') == 'BEDINFO':
                        m = re.search(r'(\d+)', entry.get('body') or '')
                        if m:
                            beds = int(m.group(1))
                            bedrooms = beds
                            break
            except Exception:
                pass

            is_guest_favorite = bool(
                listing.get('is_guest_favorite') or
                listing.get('isGuestFavorite') or
                any('GUEST_FAVORITE' in str(b).upper() for b in badges)
            )
            instant_book = bool(
                listing.get('ib') or listing.get('instant_book') or
                listing.get('is_instant_bookable') or listing.get('isInstantBookable') or
                any('INSTANT' in str(b).upper() for b in badges)
            )

            def detect_is_home(item):
                if item.get('entire_place') or item.get('is_entire_place'):
                    return True
                rt = item.get('roomType') or item.get('type') or ''
                if isinstance(rt, str) and ('entire' in rt.lower() or 'home' in rt.lower()):
                    return True
                for text_key in ('name', 'title', 'summary'):
                    tx = item.get(text_key) or ''
                    if isinstance(tx, str) and re.search(r'\b(entire|home|house|apt|apartment|studio)\b', tx, re.I):
                        return True
                sc = item.get('structuredContent') or {}
                for arr_key in ('primaryLine', 'mapPrimaryLine', 'secondaryLine', 'mapSecondaryLine'):
                    for entry in (sc.get(arr_key) or []):
                        body = (entry.get('body') if isinstance(entry, dict) else str(entry)) or ''
                        if isinstance(body, str) and re.search(r'\b(entire|home|house|apt|apartment|studio)\b', body, re.I):
                            return True
                return any(isinstance(b, str) and re.search(r'HOME|ENTIRE', b, re.I) for b in badges)

            formatted_results.append({
                'id':             listing_id,
                'url':            pick('url', 'listing_url'),
                'name':           pick('name', 'title'),
                'price':          price,
                'currency':       currency,
                'rating':         rating_value,
                'reviewsCount':   pick('reviewsCount', 'review_count') or review_count_from_rating or 0,
                'roomType':       pick('roomType', 'type'),
                'guests':         pick('guests', 'person_capacity'),
                'address':        pick('address', 'location_address'),
                'lat':            lat,
                'lng':            lng,
                'hostId':         pick('hostId', 'host_id'),
                'hostName':       pick('hostName', 'host_name'),
                'hostIsSuperhost': pick('hostIsSuperhost', 'host_is_superhost') or (
                    isinstance(listing.get('host'), dict) and
                    listing['host'].get('is_superhost')
                ),
                'photos':         photos,
                'badges':         badges,
                'isGuestFavorite': is_guest_favorite,
                'instantBook':    instant_book,
                'isHome':         bool(detect_is_home(listing)),
                'bedrooms':       bedrooms,
                'beds':           beds,
            })

        return formatted_results

    except Exception as e:
        import traceback
        raise Exception(f"Search error: {str(e)}\nTraceback: {traceback.format_exc()}")


def main():
    if len(sys.argv) != 3:
        print("Usage: python search_listings.py <input_file> <output_file>")
        sys.exit(1)

    input_file  = sys.argv[1]
    output_file = sys.argv[2]

    try:
        with open(input_file, 'r') as f:
            params = json.load(f)

        results = search_listings(params)

        with open(output_file, 'w') as f:
            json.dump(results, f)

        sys.exit(0)

    except Exception as e:
        with open(output_file, 'w') as f:
            json.dump({'error': str(e), 'results': []}, f)
        sys.exit(1)


if __name__ == '__main__':
    main()
