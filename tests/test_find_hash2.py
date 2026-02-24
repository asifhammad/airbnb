from curl_cffi import requests as cffi_requests
import re

headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}

# Fetch the actual Airbnb search page (not homepage) — the hash is loaded here
print("Fetching search page...")
search_page = cffi_requests.get(
    "https://www.airbnb.com/s/Toronto--Canada/homes",
    headers=headers,
    impersonate="chrome124"
)
print("Status:", search_page.status_code)

# Find ALL muscache JS URLs on the search page
all_js = re.findall(r"https://a0\.muscache\.com/airbnb/static/packages/web/[^\"'\s]+\.js", search_page.text)
print(f"Found {len(all_js)} JS URLs on search page")

# Look for any that mention StaysSearch
stays_js = [u for u in all_js if 'stays' in u.lower() or 'search' in u.lower()]
print("StaysSearch related:", stays_js[:5])

# Try fetching each one and look for the hash
for js_url in all_js[:20]:  # check first 20
    try:
        r = cffi_requests.get(js_url, headers=headers, impersonate="chrome124", timeout=10)
        if r.status_code == 200:
            matches = re.findall(r'[0-9a-f]{64}', r.text)
            if matches:
                print(f"\nFound 64-char hash in: {js_url}")
                print("Hashes:", matches[:3])
                # Check if it's near StaysSearch
                for m in matches:
                    idx = r.text.find(m)
                    context = r.text[max(0,idx-100):idx+100]
                    if 'stays' in context.lower() or 'search' in context.lower() or 'operation' in context.lower():
                        print(f"LIKELY MATCH: {m}")
                        print("Context:", context)
    except Exception as e:
        pass
