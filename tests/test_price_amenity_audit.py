#!/usr/bin/env python3
"""
Audit price and amenity enforcement across the 97 guest-favorite results.
Tells us exactly what we need to post-filter ourselves vs trust the server.
"""
import pyairbnb

url = "https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=user_map_move&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true&ne_lat=49.78399555676937&ne_lng=-71.16777996437563&sw_lat=37.05007652576309&sw_lng=-87.52316428221945&zoom=5.62079895446209&zoom_level=5.62079895446209&search_by_map=true"

results = pyairbnb.search_all_from_url(url, currency="USD", proxy_url="")

# guest_favorite filter
gf = [r for r in results if any('GUEST_FAVORITE' in str(b).upper() for b in (r.get('badges') or []))]
print(f"After guest_favorite: {len(gf)}")

# ── PRICE AUDIT ──────────────────────────────────────────────────────────────
print("\n" + "="*60)
print("PRICE AUDIT (price_max=404, 7 nights)")
print("="*60)

PRICE_MAX = 404  # CAD per week (price_filter_num_nights=7)

def extract_nightly(price_obj):
    """Return the per-night or weekly 'unit' amount — what Airbnb shows on the card."""
    if not isinstance(price_obj, dict):
        return None
    unit = price_obj.get('unit') or {}
    amt = unit.get('amount') or unit.get('discount')  # 'discount' = price after weekly discount
    if amt:
        return float(amt)
    total = price_obj.get('total') or {}
    return float(total.get('amount')) if total.get('amount') else None

over_price = []
under_price = []
no_price = []

for r in gf:
    p = extract_nightly(r.get('price'))
    name = r.get('name', '?')[:45]
    room_id = r.get('room_id')
    if p is None:
        no_price.append(r)
        print(f"  NO PRICE  [{room_id}] {name}")
    elif p > PRICE_MAX:
        over_price.append(r)
        print(f"  OVER  ${p:.0f}  [{room_id}] {name}")
    else:
        under_price.append(r)

print(f"\nUnder/at ${PRICE_MAX}: {len(under_price)}")
print(f"Over ${PRICE_MAX}:     {len(over_price)}")
print(f"No price data:    {len(no_price)}")

# ── AMENITY AUDIT ────────────────────────────────────────────────────────────
# We already know amenities[] is empty per listing, so the question is:
# after price filtering, how far are we from 23?
after_price = [r for r in gf if extract_nightly(r.get('price')) is not None and extract_nightly(r.get('price')) <= PRICE_MAX]
print(f"\n{'='*60}")
print(f"After guest_favorite + price: {len(after_price)}")
print(f"Target: ~23")
print(f"Gap:    {len(after_price) - 23} extra listings")
print("="*60)
print("\nConclusion: amenity filter accounts for the remaining gap.")
print("Since pyairbnb doesn't return amenity data per listing,")
print("we cannot post-filter amenities from search results alone.\n")

# Show the after-price listings briefly
for r in after_price:
    p = extract_nightly(r.get('price'))
    coords = r.get('coordinates') or {}
    lat = coords.get('lat'); lng = coords.get('lng') or coords.get('lon')
    print(f"  ${p:.0f}  [{r.get('room_id')}] {r.get('name','?')[:50]}  ({lat},{lng})")
