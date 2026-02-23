#!/usr/bin/env python3
"""
Test script to verify pyairbnb functionality
"""

import json
import pyairbnb
from datetime import datetime, timedelta

def test_search_listings():
    """Test searching for listings"""
    print("🔍 Testing listing search...")
    
    try:
        # Search parameters for a popular location (Manhattan, NYC)
        search_params = {
            'check_in': '2026-03-15',
            'check_out': '2026-03-18', 
            'ne_lat': 40.7831,
            'ne_long': -73.9712,
            'sw_lat': 40.7489,
            'sw_long': -74.0059,
            'price_min': 50,
            'price_max': 200,
            'guests': 2,
            'currency': 'USD'
        }
        
        print(f"   Searching in Manhattan, NYC for 2 guests, Mar 15-18, 2026")
        print(f"   Price range: ${search_params['price_min']}-${search_params['price_max']}")
        
        results = pyairbnb.search_all(
            check_in=search_params['check_in'],
            check_out=search_params['check_out'],
            ne_lat=search_params['ne_lat'],
            ne_long=search_params['ne_long'],
            sw_lat=search_params['sw_lat'],
            sw_long=search_params['sw_long'],
            zoom_value=10,
            price_min=search_params['price_min'],
            price_max=search_params['price_max'],
            place_type='',
            amenities=[],
            free_cancellation=False,
            currency=search_params['currency'],
            proxy_url=''
        )
        
        if results:
            print(f"   ✅ Found {len(results)} listings!")
            
            # Show first listing details
            first_listing = results[0]
            print(f"   📍 First listing: {first_listing.get('name', 'N/A')}")
            print(f"   💰 Price: {first_listing.get('price', 'N/A')}")
            print(f"   ⭐ Rating: {first_listing.get('rating', 'N/A')} ({first_listing.get('reviewsCount', 0)} reviews)")
            print(f"   🏠 Type: {first_listing.get('roomType', 'N/A')}")
            
            return results
        else:
            print("   ❌ No listings found")
            return []
            
    except Exception as e:
        print(f"   ❌ Search failed: {str(e)}")
        return []

def test_get_listing_details(listing_id):
    """Test getting detailed listing information"""
    print(f"\n🏠 Testing listing details for ID: {listing_id}")
    
    try:
        data = pyairbnb.get_details(
            room_id=listing_id,
            currency='USD',
            proxy_url=''
        )
        
        if data:
            print(f"   ✅ Successfully retrieved listing details!")
            print(f"   📝 Name: {data.get('name', 'N/A')}")
            print(f"   💰 Price: {data.get('price', 'N/A')}")
            print(f"   ⭐ Rating: {data.get('rating', 'N/A')}")
            print(f"   🏠 Type: {data.get('roomType', 'N/A')}")
            print(f"   👥 Guests: {data.get('guests', 'N/A')}")
            print(f"   🛏️ Bedrooms: {data.get('bedrooms', 'N/A')}")
            print(f"   🛁 Bathrooms: {data.get('bathrooms', 'N/A')}")
            print(f"   📍 Address: {data.get('address', 'N/A')}")
            print(f"   🔗 URL: {data.get('url', 'N/A')}")
            
            return data
        else:
            print("   ❌ No details retrieved")
            return None
            
    except Exception as e:
        print(f"   ❌ Get details failed: {str(e)}")
        return None

def test_get_calendar(listing_id):
    """Test getting listing calendar/availability"""
    print(f"\n📅 Testing calendar for listing ID: {listing_id}")
    
    try:
        data = pyairbnb.get_calendar(
            room_id=listing_id,
            currency='USD',
            proxy_url=''
        )
        
        if data:
            print(f"   ✅ Successfully retrieved calendar!")
            
            # Check if we have calendar data
            if isinstance(data, dict) and 'calendar' in data:
                calendar_data = data['calendar']
                if calendar_data and len(calendar_data) > 0:
                    print(f"   📊 Calendar entries found: {len(calendar_data)}")
                    
                    # Show first few entries
                    for i, entry in enumerate(calendar_data[:3]):
                        date = entry.get('date', 'N/A')
                        available = entry.get('available', 'N/A')
                        price = entry.get('price', 'N/A')
                        print(f"      {date}: {'Available' if available else 'Not available'} - {price}")
                else:
                    print("   ⚠️ Calendar data is empty")
            else:
                print(f"   📊 Calendar data structure: {type(data)}")
                print(f"   📊 Keys: {list(data.keys()) if isinstance(data, dict) else 'Not a dict'}")
            
            return data
        else:
            print("   ❌ No calendar data retrieved")
            return None
            
    except Exception as e:
        print(f"   ❌ Get calendar failed: {str(e)}")
        return None

def main():
    """Run all tests"""
    print("🚀 Testing pyairbnb functionality\n")
    print("=" * 50)
    
    # Test 1: Search for listings
    search_results = test_search_listings()
    
    if not search_results:
        print("\n❌ Search test failed - cannot continue with other tests")
        return
    
    # Test 2: Get details for first listing
    first_listing = search_results[0]
    listing_id = first_listing.get('id')
    
    if listing_id:
        details = test_get_listing_details(listing_id)
        
        # Test 3: Get calendar for the same listing
        if details:
            test_get_calendar(listing_id)
    else:
        print("\n❌ No listing ID found in search results")
    
    print("\n" + "=" * 50)
    print("✅ Test completed!")

if __name__ == "__main__":
    main()