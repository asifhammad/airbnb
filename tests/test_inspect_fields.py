#!/usr/bin/env python3
"""
Inspect passportData and structuredContent to find where ib/instant_book hides
"""
import pyairbnb, json

url = "https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=user_map_move&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true&ne_lat=49.78399555676937&ne_lng=-71.16777996437563&sw_lat=37.05007652576309&sw_lng=-87.52316428221945&zoom=5.62079895446209&zoom_level=5.62079895446209&search_by_map=true"

results = pyairbnb.search_all_from_url(url, currency="USD", proxy_url="")
print(f"Total: {len(results)}")

# Print full raw data of first 3 results
for i, r in enumerate(results[:3]):
    print(f"\n{'='*60}")
    print(f"Listing {i+1}: {r.get('name','?')}")
    print(f"{'='*60}")
    print("passportData:", json.dumps(r.get('passportData', {}), indent=2, default=str))
    print("structuredContent:", json.dumps(r.get('structuredContent', {}), indent=2, default=str))
    print("paymentMessages:", json.dumps(r.get('paymentMessages', []), indent=2, default=str))
    print("badges:", r.get('badges'))
    print("type:", r.get('type'))
    print("kind:", r.get('kind'))
    print("category:", r.get('category'))

# Badge survey across all results
print(f"\n{'='*60}")
print("ALL BADGES across all 280 results:")
from collections import Counter
badge_counts = Counter()
for r in results:
    for b in (r.get('badges') or []):
        badge_counts[str(b)] += 1
print(dict(badge_counts.most_common(30)))
