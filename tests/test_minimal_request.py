import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'python'))
from airbnb_search import HEADERS, get_api_key
from curl_cffi import requests as cffi_requests
import json

# Test 1: Can we reach the API at all?
api_key = get_api_key()
print("API key:", api_key[:20], "...")

op_hash = "e75ccaa7c9468e19d7613208b37d05f9b680529490ca9bc9d3361202ca0a4e43"

# Minimal payload — as few params as possible
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
            "cursor": "",
            "requestedPageType": "STAYS_SEARCH",
            "metadataOnly": False,
            "source": "structured_search_input_header",
            "searchType": "user_map_move",
            "treatmentFlags": [],
            "rawParams": [
                {"filterName": "query",       "filterValues": ["Toronto, Canada"]},
                {"filterName": "placeId",     "filterValues": ["ChIJpTvG15DL1IkRd8S0KlBVNTI"]},
                {"filterName": "checkin",     "filterValues": ["2026-03-03"]},
                {"filterName": "checkout",    "filterValues": ["2026-03-10"]},
                {"filterName": "itemsPerGrid","filterValues": ["18"]},
                {"filterName": "version",     "filterValues": ["1.8.3"]},
            ],
        },
        "staysSearchRequest": {
            "cursor": "",
            "maxMapItems": 9999,
            "requestedPageType": "STAYS_SEARCH",
            "metadataOnly": False,
            "source": "structured_search_input_header",
            "searchType": "user_map_move",
            "treatmentFlags": [],
            "rawParams": [
                {"filterName": "query",       "filterValues": ["Toronto, Canada"]},
                {"filterName": "placeId",     "filterValues": ["ChIJpTvG15DL1IkRd8S0KlBVNTI"]},
                {"filterName": "checkin",     "filterValues": ["2026-03-03"]},
                {"filterName": "checkout",    "filterValues": ["2026-03-10"]},
                {"filterName": "itemsPerGrid","filterValues": ["18"]},
                {"filterName": "version",     "filterValues": ["1.8.3"]},
            ],
        },
    },
}

from urllib.parse import urlencode
url = f"https://www.airbnb.com/api/v3/StaysSearch/{op_hash}?{urlencode({'operationName': 'StaysSearch', 'locale': 'en', 'currency': 'USD'})}"
headers = {**HEADERS, "X-Airbnb-Api-Key": api_key}

print("Sending minimal request...")
resp = cffi_requests.post(url, json=payload, headers=headers, impersonate="chrome124")
print("Status:", resp.status_code)

data = resp.json()
if data.get('errors'):
    print("ERRORS:", json.dumps(data['errors'][0]['message']))
else:
    import pyairbnb.standardize as standardize
    results = standardize.from_search(data)
    print("Results:", len(results))
