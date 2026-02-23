#!/usr/bin/env python3
"""
1. Check paymentMessages across all 280 results for any IB signal
2. Fetch full listing details for a few listings to see if ib is there
"""
import pyairbnb, json
from collections import Counter

url = "https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=user_map_move&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true&ne_lat=49.78399555676937&ne_lng=-71.16777996437563&sw_lat=37.05007652576309&sw_lng=-87.52316428221945&zoom=5.62079895446209&zoom_level=5.62079895446209&search_by_map=true"

print("Fetching search results...")
results = pyairbnb.search_all_from_url(url, currency="USD", proxy_url="")
print(f"Total: {len(results)}")

# --- 1. Survey ALL paymentMessages types across all listings ---
print("\n" + "="*60)
print("paymentMessages types across all 280 listings:")
msg_types = Counter()
msg_texts = Counter()
for r in results:
    for m in (r.get('paymentMessages') or []):
        msg_types[m.get('type', 'UNKNOWN')] += 1
        msg_texts[m.get('text', '?')[:60]] += 1
print("Types:", dict(msg_types.most_common(20)))
print("Texts:", dict(msg_texts.most_common(20)))

# --- 2. Check the raw JSON for a few listings to see every field ---
print("\n" + "="*60)
print("First 3 listings — ALL fields:")
for r in results[:3]:
    print(f"\n  [{r.get('room_id')}] {r.get('name')}")
    print(f"  paymentMessages: {r.get('paymentMessages')}")
    print(f"  fee: {r.get('fee')}")
    print(f"  category: {r.get('category')}")
    print(f"  kind: {r.get('kind')}")

# --- 3. Fetch full listing details for first 3 guest-favorite listings ---
gf_results = [r for r in results if any('GUEST_FAVORITE' in str(b).upper() for b in (r.get('badges') or []))]
print(f"\n{'='*60}")
print(f"Fetching get_details for first 3 guest-favorite listings...")
for r in gf_results[:3]:
    room_id = r.get('room_id')
    name = r.get('name')
    print(f"\n--- {name} (id={room_id}) ---")
    try:
        details = pyairbnb.get_details(
            room_id=room_id,
            currency="USD",
            check_in="2026-03-03",
            check_out="2026-03-10",
            adults=2,
            proxy_url=""
        )
        # Search for ib/instant related keys
        details_str = json.dumps(details, default=str).lower()
        for term in ['instant', '"ib"', 'instant_book', 'is_instant']:
            idx = details_str.find(term)
            if idx != -1:
                print(f"  FOUND '{term}': ...{details_str[max(0,idx-50):idx+150]}...")
            else:
                print(f"  '{term}': NOT in details")
        # Print top-level keys
        if isinstance(details, dict):
            print(f"  top-level keys: {list(details.keys())[:20]}")
    except Exception as e:
        print(f"  ERROR: {e}")
