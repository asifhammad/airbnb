#!/usr/bin/env python3
"""
Dump all 97 guest-favorite results so we can cross-reference with the 23 UI results
and understand what's different. Also checks bbox filtering.
"""
import pyairbnb, json

url = "https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=user_map_move&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true&ne_lat=49.78399555676937&ne_lng=-71.16777996437563&sw_lat=37.05007652576309&sw_lng=-87.52316428221945&zoom=5.62079895446209&zoom_level=5.62079895446209&search_by_map=true"

# Toronto proper bounding box (much tighter than the URL's huge bbox)
# The URL bbox covers half of Ontario — Toronto city proper is roughly:
TORONTO_NE_LAT = 43.855
TORONTO_NE_LNG = -79.115
TORONTO_SW_LAT = 43.580
TORONTO_SW_LNG = -79.640

results = pyairbnb.search_all_from_url(url, currency="USD", proxy_url="")

# Apply guest_favorite filter
gf = [r for r in results if any('GUEST_FAVORITE' in str(b).upper() for b in (r.get('badges') or []))]
print(f"After guest_favorite: {len(gf)}")

# Check coordinates availability
has_coords = [r for r in gf if r.get('coordinates')]
print(f"Have coordinates: {len(has_coords)} / {len(gf)}")
if has_coords:
    print(f"Sample coords: {has_coords[0].get('coordinates')}")

# Apply Toronto bbox filter
def in_toronto_bbox(r):
    coords = r.get('coordinates') or {}
    lat = coords.get('lat') or coords.get('latitude')
    lng = coords.get('lng') or coords.get('longitude') or coords.get('lon')
    if lat is None or lng is None:
        return True  # keep if no coords — don't false-negative
    return TORONTO_SW_LAT <= float(lat) <= TORONTO_NE_LAT and TORONTO_SW_LNG <= float(lng) <= TORONTO_NE_LNG

in_bbox = [r for r in gf if in_toronto_bbox(r)]
print(f"After Toronto bbox filter: {len(in_bbox)}")

print(f"\n{'='*60}")
print("All guest-favorite results with coords:")
print(f"{'='*60}")
for r in gf:
    coords = r.get('coordinates') or {}
    lat = coords.get('lat') or coords.get('latitude')
    lng = coords.get('lng') or coords.get('longitude') or coords.get('lon')
    in_box = in_toronto_bbox(r)
    room_id = r.get('room_id')
    name = r.get('name', '?')
    badges = r.get('badges', [])
    marker = "✓ IN BOX" if in_box else "✗ OUTSIDE"
    print(f"  [{room_id}] {name[:50]}")
    print(f"    lat={lat} lng={lng}  {marker}  badges={badges}")
    print(f"    https://www.airbnb.com/rooms/{room_id}")
