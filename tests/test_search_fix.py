#!/usr/bin/env python3
"""
Test search_listings.py using the real Toronto URL via search_all_from_url
"""
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src', 'python'))

from src.python.search_listings import search_listings

params = {
    # The original URL is the key input now — everything else is derived from it
    "search_url": "https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=user_map_move&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true&ne_lat=46.85271074490607&ne_lng=-75.25804288436854&sw_lat=40.487057988016566&sw_lng=-83.43290136222652&zoom=6.621298954462094&zoom_level=6.621298954462094&search_by_map=true",

    # These are still used for post-filters and fallback
    "check_in": "2026-03-03",
    "check_out": "2026-03-10",
    "guest_favorite": True,
    "instant_book": True,
    "min_beds": 1,
    "amenities": [51, 33, 8, 5],
    "refinement_paths": ["/homes"],
    "price_filter_num_nights": 7,
    "currency": "USD",
    "proxy_url": ""
}

print("=" * 60)
print("TEST: Toronto search via search_all_from_url")
print("=" * 60)

results = search_listings(params)

print("=" * 60)
print(f"FINAL RESULT COUNT: {len(results)}")
print(f"TARGET:             ~23")
print(f"PREVIOUS (broken):  280")
print("=" * 60)

if results:
    print(f"\nFirst 5 listings:")
    for r in results[:5]:
        print(f"  [{r['id']}] {r['name']}")
        print(f"    price={r['price']}  beds={r['beds']}  guestFav={r['isGuestFavorite']}  instantBook={r['instantBook']}  isHome={r['isHome']}")
        print(f"    badges={r['badges']}")
else:
    print("\nNo results — check DEBUG output above for where filtering dropped everything.")
