import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'python'))
from airbnb_search import get_api_key, build_raw_params, search_page, get_op_hash
from urllib.parse import urlparse, parse_qs
import pyairbnb.utils as utils
import json

url = "https://www.airbnb.com/s/Toronto--Canada/homes?refinement_paths%5B%5D=%2Fhomes&place_id=ChIJpTvG15DL1IkRd8S0KlBVNTI&date_picker_type=calendar&checkin=2026-03-03&checkout=2026-03-10&adults=2&infants=1&search_type=filter_change&query=Toronto%2C%20Canada&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-03-01&monthly_length=3&monthly_end_date=2026-06-01&search_mode=regular_search&price_filter_input_type=2&price_filter_num_nights=7&channel=EXPLORE&amenities%5B%5D=51&amenities%5B%5D=33&amenities%5B%5D=8&amenities%5B%5D=5&selected_filter_order%5B%5D=amenities%3A51&selected_filter_order%5B%5D=ib%3Atrue&selected_filter_order%5B%5D=amenities%3A33&selected_filter_order%5B%5D=amenities%3A8&selected_filter_order%5B%5D=price_max%3A404&selected_filter_order%5B%5D=min_beds%3A1&selected_filter_order%5B%5D=amenities%3A5&selected_filter_order%5B%5D=guest_favorite%3Atrue&update_selected_filters=false&ib=true&price_max=404&min_beds=1&guest_favorite=true"

qs = parse_qs(urlparse(url).query)
raw_params = build_raw_params(qs)
api_key = get_api_key()
op_hash = get_op_hash()
print("Using hash:", op_hash[:16])

data = search_page(api_key, "", raw_params, "USD", "en", op_hash)

# Save full response
with open('/tmp/raw_response2.json', 'w') as f:
    json.dump(data, f, indent=2, default=str)
print("Saved to /tmp/raw_response2.json")

# Check errors
if data.get('errors'):
    print("ERRORS:", json.dumps(data['errors'], indent=2))

# Walk the data tree to find where listings are
def find_listings(obj, path=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            new_path = f"{path}.{k}" if path else k
            if k in ('searchResults', 'listings', 'results', 'items', 'edges', 'nodes'):
                print(f"  FOUND key '{k}' at {new_path}: type={type(v).__name__} len={len(v) if isinstance(v, (list,dict)) else 'N/A'}")
                if isinstance(v, list) and len(v) > 0:
                    print(f"    First item keys: {list(v[0].keys()) if isinstance(v[0], dict) else type(v[0])}")
            find_listings(v, new_path)
    elif isinstance(obj, list) and len(obj) > 0:
        find_listings(obj[0], f"{path}[0]")

print("\nSearching for listing arrays in response:")
find_listings(data)

# Also check specific known paths
for path in [
    "data.presentation.staysSearch.results.searchResults",
    "data.presentation.staysSearch.results",
    "data.presentation.staysSearch",
]:
    val = utils.get_nested_value(data, path, "NOT_FOUND")
    t = type(val).__name__
    l = len(val) if isinstance(val, (list, dict)) else "N/A"
    print(f"\n{path}: type={t} len={l}")
    if isinstance(val, dict):
        print(f"  keys: {list(val.keys())}")
