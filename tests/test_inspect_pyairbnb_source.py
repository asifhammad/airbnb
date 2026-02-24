#!/usr/bin/env python3
"""
Locate and print the pyairbnb source files so we know exactly what fields
are returned and what search_all_from_url does.
"""
import inspect
import os
import pyairbnb

pkg_file = inspect.getfile(pyairbnb)
pkg_dir = os.path.dirname(pkg_file)
print(f"pyairbnb installed at: {pkg_dir}\n")

# List all .py files
for f in sorted(os.listdir(pkg_dir)):
    if f.endswith('.py'):
        full = os.path.join(pkg_dir, f)
        size = os.path.getsize(full)
        print(f"  {f}  ({size} bytes)")

print("\n" + "="*60)

# Print every .py file in full
for f in sorted(os.listdir(pkg_dir)):
    if f.endswith('.py'):
        full = os.path.join(pkg_dir, f)
        print(f"\n\n{'='*60}")
        print(f"FILE: {f}")
        print('='*60)
        with open(full) as fh:
            print(fh.read())
