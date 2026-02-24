#!/usr/bin/env python3
"""
Inspect raw pyairbnb data shape to understand what fields are available
for instant_book, guest_favorite, amenities detection
"""
import json
import pyairbnb

results = pyairbnb.search_all(
    check_in="2026-03-03", check_out="2026-03-10",
    ne_lat=43.8, ne_long=-79.1, sw_lat=43.5, sw_long=-79.6,
    zoom_value=12,
    price_max=404, adults=2, currency="USD", proxy_url=""
)

print(f"Total results: {len(results)}")
print("=" * 60)

# Print full raw data of first 3 results
for i, r in enumerate(results[:3]):
    print(f"\n--- Listing {i+1} (room_id={r.get('room_id')}) ---")
    print(json.dumps(r, indent=2, default=str))
    print()

# Also scan ALL results and tally what badges appear
print("=" * 60)
print("ALL BADGES across all results:")
from collections import Counter
badge_counts = Counter()
for r in results:
    for b in (r.get('badges') or []):
        badge_counts[str(b)] += 1
print(dict(badge_counts.most_common(20)))

# Check passportData and structuredContent for instant_book hints
print("\n--- passportData sample (first result) ---")
print(json.dumps(results[0].get('passportData', {}), indent=2, default=str))

print("\n--- structuredContent sample (first result) ---")
print(json.dumps(results[0].get('structuredContent', {}), indent=2, default=str))
