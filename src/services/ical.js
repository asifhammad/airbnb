import axios from 'axios';
import ICAL from 'ical.js';

/**
 * Fetch and parse iCal feed for Airbnb listing
 * @param {string} listingId - Airbnb listing ID
 * @returns {Promise<Array>} - Array of blocked date ranges
 */
export async function fetchICalData(listingId) {
  const icalUrl = `https://www.airbnb.com/calendar/ical/${listingId}.ics`;
  
  try {
    const response = await axios.get(icalUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AirbnbAlerts/1.0)'
      }
    });

    const jcalData = ICAL.parse(response.data);
    const comp = new ICAL.Component(jcalData);
    const vevents = comp.getAllSubcomponents('vevent');

    const blockedRanges = vevents.map(vevent => {
      const event = new ICAL.Event(vevent);
      return {
        start: event.startDate.toJSDate(),
        end: event.endDate.toJSDate(),
        summary: event.summary
      };
    });

    return blockedRanges;
  } catch (error) {
    const status = error?.response?.status ? ` status=${error.response.status}` : '';
    console.warn(`iCal fetch failed for listing ${listingId}:${status} ${error.message}`);
    throw error;
  }
}

/**
 * Check if dates are available for a listing
 * @param {string} listingId - Airbnb listing ID
 * @param {Date|string} checkIn - Check-in date
 * @param {Date|string} checkOut - Check-out date
 * @returns {Promise<boolean>} - True if available, false if blocked
 */
export async function checkICalAvailability(listingId, checkIn, checkOut) {
  try {
    const blockedRanges = await fetchICalData(listingId);
    
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);

    // Check if any blocked range overlaps with desired dates
    for (const blocked of blockedRanges) {
      const blockedStart = new Date(blocked.start);
      const blockedEnd = new Date(blocked.end);

      // Check for overlap
      if (
        (checkInDate >= blockedStart && checkInDate < blockedEnd) ||
        (checkOutDate > blockedStart && checkOutDate <= blockedEnd) ||
        (checkInDate <= blockedStart && checkOutDate >= blockedEnd)
      ) {
        return false; // Dates are blocked
      }
    }

    return true; // Dates are available
  } catch (error) {
    const status = error?.response?.status ? ` status=${error.response.status}` : '';
    console.warn(`iCal availability check failed for listing ${listingId}:${status} ${error.message}`);
    throw error;
  }
}

/**
 * Get all available date ranges for a listing in the next N months
 * @param {string} listingId - Airbnb listing ID
 * @param {number} months - Number of months to check (default: 3)
 * @returns {Promise<Array>} - Array of available date ranges
 */
export async function getAvailableDateRanges(listingId, months = 3) {
  try {
    const blockedRanges = await fetchICalData(listingId);
    
    const today = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + months);

    // Sort blocked ranges by start date
    blockedRanges.sort((a, b) => a.start - b.start);

    const availableRanges = [];
    let currentDate = new Date(today);

    for (const blocked of blockedRanges) {
      if (blocked.start > currentDate) {
        // There's a gap - this is an available range
        availableRanges.push({
          start: new Date(currentDate),
          end: new Date(blocked.start)
        });
      }
      currentDate = new Date(Math.max(currentDate, blocked.end));
    }

    // Add final range if there's space before end date
    if (currentDate < endDate) {
      availableRanges.push({
        start: new Date(currentDate),
        end: new Date(endDate)
      });
    }

    return availableRanges;
  } catch (error) {
    const status = error?.response?.status ? ` status=${error.response.status}` : '';
    console.warn(`iCal available ranges failed for listing ${listingId}:${status} ${error.message}`);
    throw error;
  }
}

export default {
  fetchICalData,
  checkICalAvailability,
  getAvailableDateRanges
};
