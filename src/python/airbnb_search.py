#!/usr/bin/env python3
"""
Direct Airbnb GraphQL search — bypasses pyairbnb's broken search.get()
which has hardcoded Galapagos placeId/query in rawParams.

Builds rawParams correctly from the original URL, including:
  - place_id, query (location)
  - checkin/checkout
  - price_min/max
  - amenities
  - guest_favorite
  - ib (instant book)
  - min_beds, min_bedrooms
  - adults, children, infants
  - neLat/neLng/swLat/swLng/zoomLevel
"""

from urllib.parse import urlparse, parse_qs, urlencode
from curl_cffi import requests as cffi_requests
import json
import re

# ── Hardcoded in pyairbnb, works as fallback ──────────────────────────────
DEFAULT_HASH = 'e75ccaa7c9468e19d7613208b37d05f9b680529490ca9bc9d3361202ca0a4e43'

HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en",
    "content-type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
}

TREATMENTS = [
    "feed_map_decouple_m11_treatment",
    "stays_search_rehydration_treatment_desktop",
    "stays_search_rehydration_treatment_moweb",
    "selective_query_feed_map_homepage_desktop_treatment",
    "selective_query_feed_map_homepage_moweb_treatment",
]


def get_api_key(proxy_url=""):
    """Fetch Airbnb API key (same as pyairbnb.api.get)"""
    import pyairbnb.api as api
    return api.get(proxy_url)


def build_raw_params(qs):
    """
    Build the rawParams list from parsed URL querystring.
    This is what pyairbnb's search.get() should do but doesn't —
    it hardcodes Galapagos placeId/query instead of reading from URL.
    """
    def first(key, default=None):
        vals = qs.get(key, [])
        return vals[0] if vals else default

    ne_lat   = first("ne_lat",  first("ne_lat"))
    ne_lng   = first("ne_lng",  first("ne_long"))
    sw_lat   = first("sw_lat")
    sw_lng   = first("sw_lng",  first("sw_long"))
    zoom     = first("zoom_level", first("zoom", "12"))
    place_id = first("place_id", "")
    query    = first("query", "")
    check_in  = first("checkin")
    check_out = first("checkout")
    price_min = first("price_min")
    price_max = first("price_max")
    min_beds  = first("min_beds")
    min_bedrooms = first("min_bedrooms")
    min_bathrooms = first("min_bathrooms")
    adults   = first("adults")
    children = first("children")
    infants  = first("infants")
    ib       = first("ib", "false")
    guest_favorite = first("guest_favorite", "false")
    room_types = qs.get("room_types[]", [])
    amenities  = qs.get("amenities[]", [])
    free_cancellation = first("flexible_cancellation", "false")

    # selected_filter_order — preserve original order from URL
    filter_order = qs.get("selected_filter_order[]", [])

    # ── Price context (critical for long stays) ──────────────────────────
    price_filter_input_type = first("price_filter_input_type")
    price_filter_num_nights = first("price_filter_num_nights")

    # ── Monthly / flexible trip context ──────────────────────────────────
    monthly_start_date = first("monthly_start_date")
    monthly_length     = first("monthly_length")
    monthly_end_date   = first("monthly_end_date")
    flexible_trip_lengths = qs.get("flexible_trip_lengths[]", [])

    # ── Base params (always sent) ─────────────────────────────────────────
    raw = [
        {"filterName": "cdnCacheSafe",       "filterValues": ["false"]},
        {"filterName": "channel",            "filterValues": ["EXPLORE"]},
        {"filterName": "datePickerType",     "filterValues": ["calendar"]},
        {"filterName": "itemsPerGrid",       "filterValues": ["50"]},
        {"filterName": "screenSize",         "filterValues": ["large"]},
        {"filterName": "refinementPaths",    "filterValues": ["/homes"]},
        {"filterName": "tabId",              "filterValues": ["home_tab"]},
        {"filterName": "version",            "filterValues": ["1.8.3"]},
    ]

    # ── Bounding box — only add when all four coords are present ──────────
    # If any are missing (e.g. URL was saved without bbox params), omitting
    # them lets Airbnb resolve the area from placeId/query alone.
    # Sending "None" as a string causes the API to return zero results.
    has_bbox = ne_lat and ne_lng and sw_lat and sw_lng
    if has_bbox:
        raw += [
            {"filterName": "searchByMap",    "filterValues": ["true"]},
            {"filterName": "neLat",          "filterValues": [str(ne_lat)]},
            {"filterName": "neLng",          "filterValues": [str(ne_lng)]},
            {"filterName": "swLat",          "filterValues": [str(sw_lat)]},
            {"filterName": "swLng",          "filterValues": [str(sw_lng)]},
            {"filterName": "zoomLevel",      "filterValues": [str(int(float(zoom)))]},
        ]
    else:
        # No bbox — let Airbnb use the placeId/query to determine the area
        print("DEBUG: build_raw_params — no bbox in URL, searching by placeId/query only")

    # ── Location ─────────────────────────────────────────────────────────
    if place_id:
        raw.append({"filterName": "placeId", "filterValues": [place_id]})
    if query:
        raw.append({"filterName": "query",   "filterValues": [query]})

    # ── Dates ─────────────────────────────────────────────────────────────
    if check_in and check_out:
        from datetime import datetime
        days = (datetime.strptime(check_out, "%Y-%m-%d") - datetime.strptime(check_in, "%Y-%m-%d")).days
        raw += [
            {"filterName": "checkin",             "filterValues": [check_in]},
            {"filterName": "checkout",            "filterValues": [check_out]},
            {"filterName": "priceFilterNumNights","filterValues": [str(days)]},
        ]

    # ── Price ─────────────────────────────────────────────────────────────
    if price_min and int(price_min) > 0:
        raw.append({"filterName": "price_min", "filterValues": [str(price_min)]})
    if price_max and int(price_max) > 0:
        raw.append({"filterName": "price_max", "filterValues": [str(price_max)]})

    # ── Price context (tells Airbnb how to interpret price_max) ──────────
    if price_filter_input_type:
        raw.append({"filterName": "priceFilterInputType", "filterValues": [str(price_filter_input_type)]})
    if price_filter_num_nights:
        raw.append({"filterName": "priceFilterNumNights", "filterValues": [str(price_filter_num_nights)]})

    # ── Monthly / long-term stay context ─────────────────────────────────
    if monthly_start_date:
        raw.append({"filterName": "monthlyStartDate", "filterValues": [monthly_start_date]})
    if monthly_length:
        raw.append({"filterName": "monthlyLength", "filterValues": [monthly_length]})
    if monthly_end_date:
        raw.append({"filterName": "monthlyEndDate", "filterValues": [monthly_end_date]})
    for ftl in flexible_trip_lengths:
        raw.append({"filterName": "flexibleTripLengths", "filterValues": [ftl]})

    # ── Guests ────────────────────────────────────────────────────────────
    if adults   and int(adults)   > 0: raw.append({"filterName": "adults",   "filterValues": [adults]})
    if children and int(children) > 0: raw.append({"filterName": "children", "filterValues": [children]})
    if infants  and int(infants)  > 0: raw.append({"filterName": "infants",  "filterValues": [infants]})

    # ── Property ──────────────────────────────────────────────────────────
    if min_beds      and int(min_beds)      > 0:
        raw.append({"filterName": "min_beds",      "filterValues": [str(min_beds)]})
    if min_bedrooms  and int(min_bedrooms)  > 0:
        raw.append({"filterName": "min_bedrooms",  "filterValues": [str(min_bedrooms)]})
    if min_bathrooms and int(min_bathrooms) > 0:
        raw.append({"filterName": "min_bathrooms", "filterValues": [str(min_bathrooms)]})

    # ── Room type ─────────────────────────────────────────────────────────
    for rt in room_types:
        raw.append({"filterName": "room_types", "filterValues": [rt]})

    # ── Amenities ─────────────────────────────────────────────────────────
    if amenities:
        raw.append({"filterName": "amenities", "filterValues": amenities})

    # ── Instant book ──────────────────────────────────────────────────────
    if ib.lower() == "true":
        raw.append({"filterName": "ib", "filterValues": ["true"]})

    # ── Guest favorite ────────────────────────────────────────────────────
    if guest_favorite.lower() == "true":
        raw.append({"filterName": "guest_favorite", "filterValues": ["true"]})

    # ── Free cancellation ─────────────────────────────────────────────────
    if free_cancellation.lower() == "true":
        raw.append({"filterName": "flexible_cancellation", "filterValues": ["true"]})

    # ── Selected filter order (preserves UI filter ordering) ──────────────
    for fo in filter_order:
        raw.append({"filterName": "selected_filter_order", "filterValues": [fo]})

    return raw


def search_page(api_key, cursor, raw_params, currency, language, op_hash, proxy_url=""):
    """Call Airbnb's StaysSearch GraphQL endpoint for one page."""
    base_url = f"https://www.airbnb.com/api/v3/StaysSearch/{op_hash}"
    url = f"{base_url}?{urlencode({'operationName': 'StaysSearch', 'locale': language, 'currency': currency})}"

    payload = {
        "operationName": "StaysSearch",
        "extensions": {
            "persistedQuery": {"version": 1, "sha256Hash": op_hash}
        },
        "variables": {
            "skipExtendedSearchParams": False,
            "includeMapResults": True,
            "isLeanTreatment": False,
            "aiSearchEnabled": False,
            "staysMapSearchRequestV2": {
                "cursor": cursor,
                "requestedPageType": "STAYS_SEARCH",
                "metadataOnly": False,
                "source": "structured_search_input_header",
                "searchType": "user_map_move",
                "treatmentFlags": TREATMENTS,
                "rawParams": raw_params,
            },
            "staysSearchRequest": {
                "cursor": cursor,
                "maxMapItems": 9999,
                "requestedPageType": "STAYS_SEARCH",
                "metadataOnly": False,
                "source": "structured_search_input_header",
                "searchType": "user_map_move",
                "treatmentFlags": TREATMENTS,
                "rawParams": raw_params,
            },
        },
    }

    headers = {**HEADERS, "X-Airbnb-Api-Key": api_key}
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else {}

    resp = cffi_requests.post(url, json=payload, headers=headers, proxies=proxies, impersonate="chrome124")
    if resp.status_code != 200:
        raise Exception(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return resp.json()


def fetch_live_hash(proxy_url=""):
    """
    Fetch the current StaysSearch operationId by scanning JS files on the
    Airbnb search page. The hash lives in a file containing:
      name:'StaysSearch',type:'query',operationId:'<64-char-hex>'
    Falls back to DEFAULT_HASH if extraction fails.
    """
    try:
        proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else {}
        headers = {"User-Agent": HEADERS["User-Agent"]}

        # Use the search page — it loads the StaysSearch operation bundle
        page = cffi_requests.get(
            "https://www.airbnb.com/s/homes",
            headers=headers, proxies=proxies, impersonate="chrome124", timeout=15
        )
        page.raise_for_status()

        # Collect all unique muscache JS URLs from the page
        js_urls = list(dict.fromkeys(
            re.findall(
                r"https://a0\.muscache\.com/airbnb/static/packages/web/[^\"'\s]+\.js",
                page.text
            )
        ))
        print(f"DEBUG: found {len(js_urls)} JS files on search page")

        # Scan each JS file for the StaysSearch operationId
        # Pattern: name:'StaysSearch',type:'query',operationId:'<hash>'
        pattern = re.compile(
            r"name:['\"]StaysSearch['\"][^}]{0,100}operationId:['\"]([0-9a-f]{64})['\"]" 
        )
        for js_url in js_urls:
            try:
                r = cffi_requests.get(js_url, headers=headers, proxies=proxies,
                                      impersonate="chrome124", timeout=10)
                if r.status_code != 200:
                    continue
                m = pattern.search(r.text)
                if m:
                    found = m.group(1)
                    print(f"DEBUG: live hash found in {js_url.split('/')[-1]}: {found[:16]}...")
                    return found
            except Exception:
                continue

        print("DEBUG: StaysSearch hash not found in any JS file — using default")
        return DEFAULT_HASH

    except Exception as e:
        print(f"DEBUG: fetch_live_hash failed ({e}) — using default")
        return DEFAULT_HASH


# Cache the hash at module load time so we only fetch it once per process
_cached_hash = None

def get_op_hash(proxy_url=""):
    global _cached_hash
    if _cached_hash is None:
        _cached_hash = fetch_live_hash(proxy_url)
    return _cached_hash


def search_from_url(url, currency="USD", language="en", proxy_url="", op_hash=None):
    """
    Full paginated search using the original Airbnb URL.
    Correctly extracts placeId, query, ib, guest_favorite, amenities etc.
    Returns raw listing dicts from pyairbnb's standardize module.
    """
    import pyairbnb.standardize as standardize
    import pyairbnb.utils as utils

    if not op_hash:
        op_hash = get_op_hash(proxy_url)

    qs = parse_qs(urlparse(url).query)

    # If no 'query' in querystring, extract location from path (/s/Location--Area/homes)
    if not qs.get('query'):
        path_match = re.match(r'^/s/([^/?#]+)', (urlparse(url).path or ''))
        if path_match:
            location_from_path = path_match.group(1).replace('--', ', ').replace('-', ' ')
            qs['query'] = [location_from_path]
            print(f'DEBUG: extracted query from path: {location_from_path}')

    raw_params = build_raw_params(qs)

    api_key = get_api_key(proxy_url)
    all_results = []
    cursor = ""
    page = 0

    while True:
        page += 1
        data = search_page(api_key, cursor, raw_params, currency, language, op_hash, proxy_url)
        results = standardize.from_search(data)
        pagination = utils.get_nested_value(
            data, "data.presentation.staysSearch.results.paginationInfo", {}
        )
        all_results.extend(results)

        next_cursor = pagination.get("nextPageCursor")
        if not results or not next_cursor:
            break
        cursor = next_cursor

    return all_results
