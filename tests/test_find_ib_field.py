#!/usr/bin/env python3
"""
Patch pyairbnb internals to intercept the raw API response before
normalization, so we can find where ib/instant_book lives.
"""
import pyairbnb
import pyairbnb.search as search_mod
import json
from unittest.mock import patch

url = "https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=user_map_move&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true&ne_lat=49.78399555676937&ne_lng=-71.16777996437563&sw_lat=37.05007652576309&sw_lng=-87.52316428221945&zoom=5.62079895446209&zoom_level=5.62079895446209&search_by_map=true"

# Intercept the raw `get()` response before pyairbnb processes it
raw_pages = []
original_get = search_mod.get

def intercepting_get(*args, **kwargs):
    data = original_get(*args, **kwargs)
    raw_pages.append(data)
    return data

with patch.object(search_mod, 'get', side_effect=intercepting_get):
    results = pyairbnb.search_all_from_url(url, currency="USD", proxy_url="")

print(f"Intercepted {len(raw_pages)} API page(s), total normalized results: {len(results)}")

# Save raw page 1 for inspection
if raw_pages:
    with open('/tmp/raw_api_page1.json', 'w') as f:
        json.dump(raw_pages[0], f, indent=2, default=str)
    print("Saved raw page 1 to /tmp/raw_api_page1.json")

    # Try to find ib/instant_book anywhere in the raw response
    raw_str = json.dumps(raw_pages[0], default=str).lower()
    for term in ['instant', '"ib"', "'ib'", 'instant_book', 'instantbook', 'is_instant']:
        idx = raw_str.find(term)
        if idx != -1:
            print(f"\nFound '{term}' at position {idx}:")
            print(raw_str[max(0,idx-100):idx+200])
        else:
            print(f"'{term}' NOT found in raw response")
