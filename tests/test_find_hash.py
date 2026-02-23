from curl_cffi import requests as cffi_requests
import re

headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}

# Fetch homepage to get the exact bundle URL
homepage = cffi_requests.get("https://www.airbnb.com/", headers=headers, impersonate="chrome124")
bundle_match = re.search(
    r"https://a0\.muscache\.com/airbnb/static/packages/web/[^/]+/frontend/airmetro/browser/asyncRequire\.[^\"']+\.js",
    homepage.text
)
bundle_url = bundle_match.group(0)
print("Bundle URL:", bundle_url)

bundle = cffi_requests.get(bundle_url, headers=headers, impersonate="chrome124")

# Get the StaysSearchRoute.prepare filename
module_match = re.search(
    r"(StaysSearchRoute/StaysSearchRoute\.prepare\.[^\"']+\.js)",
    bundle.text
)
print("Module file:", module_match.group(1) if module_match else "NOT FOUND")

# Build the module URL — extract the base path from the bundle URL
base = re.match(r"(https://a0\.muscache\.com/airbnb/static/packages/web/[^/]+/frontend/airmetro/browser/)", bundle_url)
base_url = base.group(1) if base else "https://a0.muscache.com/airbnb/static/packages/web/en/frontend/airmetro/browser/"
module_url = base_url + "common/frontend/stays-search/routes/" + module_match.group(1)
print("Module URL:", module_url)

module = cffi_requests.get(module_url, headers=headers, impersonate="chrome124")
print("Module status:", module.status_code)
print("Module size:", len(module.text), "chars")

# Search for the hash
hash_patterns = [
    r'operationId:[\'"]([0-9a-f]{64})',
    r'sha256Hash:[\'"]([0-9a-f]{64})',
    r'"([0-9a-f]{64})"',
    r"'([0-9a-f]{64})'",
]
for pat in hash_patterns:
    matches = re.findall(pat, module.text)
    if matches:
        print(f"FOUND with pattern '{pat[:40]}':", matches[0])
        break
    else:
        print(f"No match: '{pat[:40]}'")

# Print context around key terms
for term in ['operationId', 'sha256', 'persistedQuery', 'StaysSearch']:
    idx = module.text.lower().find(term.lower())
    if idx != -1:
        print(f"\nContext around '{term}':")
        print(module.text[max(0, idx-30):idx+120])
        break
