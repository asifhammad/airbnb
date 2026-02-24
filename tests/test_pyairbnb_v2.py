#!/usr/bin/env python3
"""
Enhanced test script for pyairbnb functionality with better parameters
"""

import json
import pyairbnb
from datetime import datetime, timedelta

def test_search_with_recent_dates():
    """Test searching with recent dates"""
    print("🔍 Testing listing search with recent dates...")
    
    try:
        # Use dates 2 weeks from now
        today = datetime.now()
        check_in = (today + timedelta(days=14)).strftime('%Y-%m-%d')
        check_out = (today + timedelta(days=17)).strftime('%Y-%m-%d')
        
        # Search in San Francisco (well-known test location)
        search_params = {
            'check_in': check_in,
            'check_out': check_out,
            'ne_lat': 37.8324,
            'ne_long': -122.3589,
            'sw_lat': 37.7049,
            'sw_long': -122.5279,
            'price_min': 50,
            'price_max': 300,
            'guests': 2,
            'currency': 'USD'
        }
        
        print(f"   Searching in San Francisco for 2 guests")
        print(f"   Dates: {check_in} to {check_out}")
        print(f"   Price range: ${search_params['price_min']}-${search_params['price_max']}")
        
        results = pyairbnb.search_all(
            check_in=search_params['check_in'],
            check_out=search_params['check_out'],
            ne_lat=search_params['ne_lat'],
            ne_long=search_params['ne_long'],
            sw_lat=search_params['sw_lat'],
            sw_long=search_params['sw_long'],
            zoom_value=12,
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
            print(f"   🆔 ID: {first_listing.get('id', 'N/A')}")
            
            return results
        else:
            print("   ❌ No listings found")
            return []
            
    except Exception as e:
        print(f"   ❌ Search failed: {str(e)}")
        import traceback
        traceback.print_exc()
        return []

def test_known_listing():
    """Test with a known Airbnb listing ID"""
    print(f"\n🏠 Testing with known listing ID...")
    
    # Common test listing IDs (these are examples, may not work)
    test_ids = [
        "12345678",  # Example ID
        "23456789",  # Example ID
        "34567890"   # Example ID
    ]
    
    for listing_id in test_ids:
        print(f"   Trying listing ID: {listing_id}")
        try:
            data = pyairbnb.get_details(
                room_id=listing_id,
                currency='USD',
                proxy_url=''
            )
            
            if data and data.get('name'):
                print(f"   ✅ Successfully retrieved listing details!")
                print(f"   📝 Name: {data.get('name', 'N/A')}")
                print(f"   💰 Price: {data.get('price', 'N/A')}")
                print(f"   ⭐ Rating: {data.get('rating', 'N/A')}")
                print(f"   🏠 Type: {data.get('roomType', 'N/A')}")
                print(f"   🆔 ID: {data.get('id', 'N/A')}")
                return data
            else:
                print(f"   ⚠️ Listing ID {listing_id} not found or no data")
                
        except Exception as e:
            print(f"   ⚠️ Listing ID {listing_id} failed: {str(e)}")
    
    print("   ❌ No working listing IDs found")
    return None

def test_simple_search():
    """Test with minimal parameters"""
    print(f"\n🔍 Testing simple search with minimal parameters...")
    
    try:
        # Use very recent dates
        today = datetime.now()
        check_in = (today + timedelta(days=7)).strftime('%Y-%m-%d')
        check_out = (today + timedelta(days=9)).strftime('%Y-%m-%d')
        
        print(f"   Dates: {check_in} to {check_out}")
        
        # Simple search in NYC area
        results = pyairbnb.search_all(
            check_in=check_in,
            check_out=check_out,
            ne_lat=40.7831,
            ne_long=-73.9712,
            sw_lat=40.7489,
            sw_long=-74.0059,
            zoom_value=10,
            price_min=50,
            price_max=300,
            currency='USD'
        )
        
        if results:
            print(f"   ✅ Found {len(results)} listings!")
            first_listing = results[0]
            print(f"   📍 First listing: {first_listing.get('name', 'N/A')}")
            print(f"   🆔 ID: {first_listing.get('id', 'N/A')}")
            return results
        else:
            print("   ❌ No listings found")
            return []
            
    except Exception as e:
        print(f"   ❌ Simple search failed: {str(e)}")
        import traceback
        traceback.print_exc()
        return []

def main():
    """Run all tests"""
    print("🚀 Enhanced pyairbnb functionality test\n")
    print("=" * 60)
    
    # Test 1: Simple search
    search_results = test_simple_search()
    
    # Test 2: Search with recent dates
    if not search_results:
        search_results = test_search_with_recent_dates()
    
    # Test 3: Try known listing IDs
    if not search_results:
        details = test_known_listing()
        if details:
            listing_id = details.get('id')
            if listing_id:
                print(f"\n📅 Testing calendar for working listing ID: {listing_id}")
                try:
                    calendar_data = pyairbnb.get_calendar(
                        room_id=listing_id,
                        currency='USD',
                        proxy_url=''
                    )
                    if calendar_data:
                        print(f"   ✅ Calendar retrieved successfully!")
                        print(f"   📊 Calendar type: {type(calendar_data)}")
                except Exception as e:
                    print(f"   ❌ Calendar test failed: {str(e)}")
    
    if not search_results:
        print("\n❌ All search tests failed")
        print("\nPossible issues:")
        print("1. Airbnb may be blocking requests from this IP")
        print("2. The pyairbnb library may need updates")
        print("3. Network connectivity issues")
        print("4. Airbnb may have changed their API")
    
    print("\n" + "=" * 60)
    print("✅ Test completed!")

if __name__ == "__main__":
    main()