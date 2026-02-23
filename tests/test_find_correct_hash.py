from curl_cffi import requests as cffi_requests
import re
import json

headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}

# Fetch the file we know contains the hash
url = "https://a0.muscache.com/airbnb/static/packages/web/common/823b8.d594b07531.js"
r = cffi_requests.get(url, headers=headers, impersonate="chrome124")
print("Status:", r.status_code)

# Find ALL operationId occurrences with their surrounding context
matches = list(re.finditer(r"name:'([^']+)'[^}]{0,200}operationId:'([0-9a-f]{64})'", r.text))
print(f"\nFound {len(matches)} operationId entries:")
for m in matches:
    print(f"  name='{m.group(1)}'  hash={m.group(2)[:20]}...")

# Also try with double quotes
matches2 = list(re.finditer(r'name:"([^"]+)"[^}]{0,200}operationId:"([0-9a-f]{64})"', r.text))
print(f"\nFound {len(matches2)} more (double-quote style):")
for m in matches2:
    print(f"  name='{m.group(1)}'  hash={m.group(2)[:20]}...")
