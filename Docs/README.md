# Airbnb Alerts - Backend Service

A comprehensive alert service for Airbnb listings that notifies users when new properties become available, prices drop, or specific listings become available.

## Features

- 🔍 **Search-based alerts** - Monitor searches and get notified of new listings
- 🏠 **Specific listing tracking** - Track availability of specific properties via iCal
- 💰 **Price tracking** - Get notified when prices drop
- 👥 **Subscription tiers** - Basic (1 alert, daily checks) and Premium (10 alerts, instant checks)
- 📧 **Email notifications** - Beautiful HTML email alerts
- 🔄 **Background workers** - Bull queue with Redis for job processing
- 🐍 **Python scraper** - Uses pyairbnb library for scraping

## Architecture

```
┌─────────────────┐
│   Express API   │ ← REST API for user interactions
└────────┬────────┘
         │
    ┌────▼────┐
    │ Bull    │ ← Job queue (Redis)
    │ Queue   │
    └────┬────┘
         │
    ┌────▼────────┐
    │   Worker    │ ← Processes scraping jobs
    │  (Node.js)  │
    └────┬────────┘
         │
    ┌────▼────────┐
    │   Python    │ ← pyairbnb scraper
    │  Scraper    │
    └─────────────┘
```

## Tech Stack

- **Backend**: Node.js, Express
- **Database**: PostgreSQL
- **Queue**: Bull (Redis)
- **Scraper**: Python (pyairbnb)
- **Email**: Nodemailer
- **Deployment**: Railway

## Prerequisites

- Node.js 18+
- Python 3.10+ (pyairbnb uses Python 3.10+ features; install Python 3.11 recommended)
- PostgreSQL 14+
- Redis 6+

## Installation

### 1. Clone and Install Dependencies

```bash
# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r requirements.txt
```

### 2. Environment Setup

Copy `.env.example` to `.env` and configure:

```bash
psps```

Required variables:
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `JWT_SECRET` - Secret for JWT tokens
- `EMAIL_USER` - Email for sending notifications
- `EMAIL_PASS` - Email app password

### 3. Database Setup

```bash
# Run migrations
npm run migrate
```

This will create all necessary tables.

### 4. Start Services

**Development (local):**

```bash
# Terminal 1 - API server
npm run dev

# Terminal 2 - Worker
npm run worker
```

**Production:**

```bash
# Start API
npm start

# Start worker (separate process/container)
node src/workers/scraper-worker.js
```

## Railway Deployment

### Setup

1. Create new Railway project
2. Add PostgreSQL service
3. Add Redis service
4. Connect your GitHub repo

### Environment Variables

Set these in Railway:
```
NODE_ENV=production
PORT=3000
DATABASE_URL=<auto-injected>
REDIS_URL=<auto-injected>
JWT_SECRET=<your-secret>
EMAIL_SERVICE=gmail
EMAIL_USER=<your-email>
EMAIL_PASS=<your-app-password>
EMAIL_FROM=Airbnb Alerts <noreply@example.com>
PYTHON_PATH=python3
TEMP_DIR=/tmp
```

### Deploy Two Services

1. **Web Service** (API):
   - Start command: `node src/index.js`
   - Deploy from `main` branch

2. **Worker Service** (Background jobs):
   - Start command: `node src/workers/scraper-worker.js`
   - Deploy from `main` branch
   - Same environment variables

## API Endpoints

### Authentication

```bash
# Register
POST /api/auth/register
{
  "email": "user@example.com",
  "password": "password123"
}

# Login
POST /api/auth/login
{
  "email": "user@example.com",
  "password": "password123"
}

# Get current user
GET /api/auth/me
Headers: { "Authorization": "Bearer <token>" }
```

### Alerts

```bash
# Create search alert
POST /api/alerts/search
Headers: { "Authorization": "Bearer <token>" }
{
  "location": "Paris, France",
  "check_in": "2026-03-01",
  "check_out": "2026-03-07",
  "ne_lat": 48.9,
  "ne_long": 2.5,
  "sw_lat": 48.8,
  "sw_long": 2.2,
  "price_min": 100,
  "price_max": 200,
  "guests": 2
}

# Create listing alert
POST /api/alerts/listing
Headers: { "Authorization": "Bearer <token>" }
{
  "listing_id": "12345678",
  "listing_url": "https://www.airbnb.com/rooms/12345678",
  "check_in": "2026-03-01",
  "check_out": "2026-03-07"
}

# Get all alerts
GET /api/alerts
Headers: { "Authorization": "Bearer <token>" }

# Update alert
PUT /api/alerts/:id
Headers: { "Authorization": "Bearer <token>" }
{
  "is_active": false
}

# Delete alert
DELETE /api/alerts/:id
Headers: { "Authorization": "Bearer <token>" }
```

### Listings

```bash
# Get listings for alert
GET /api/listings/alert/:alertId
Headers: { "Authorization": "Bearer <token>" }

# Get listing details
GET /api/listings/:listingId
Headers: { "Authorization": "Bearer <token>" }

# Get notifications
GET /api/listings/notifications/recent
Headers: { "Authorization": "Bearer <token>" }
```

## How It Works

### 1. User Creates Alert

User creates a search alert with their criteria (location, dates, price range).

### 2. Scheduler Adds Jobs

- **Basic users**: Cron job runs daily at 9 AM, adds alerts to queue
- **Premium users**: Cron job runs every 15 minutes, adds alerts to queue

### 3. Worker Processes Jobs

Worker picks up jobs from Redis queue and:
- Calls Python scraper with search parameters
- Python executes pyairbnb to fetch listings
- Results are compared with previous results in DB
- New listings trigger email notifications

### 4. iCal Monitoring (for specific listings)

For listing-specific alerts:
- Fetches iCal feed from Airbnb
- Parses blocked dates
- Checks if desired dates are available
- Sends notification if available

## Project Structure

```
airbnb-alerts/
├── src/
│   ├── index.js              # Express server
│   ├── db/
│   │   ├── index.js          # Database connection
│   │   └── schema.sql        # Database schema
│   ├── routes/
│   │   ├── auth.js           # Authentication routes
│   │   ├── alerts.js         # Alert management routes
│   │   └── listings.js       # Listing routes
│   ├── middleware/
│   │   └── auth.js           # JWT authentication
│   ├── workers/
│   │   ├── queue.js          # Bull queue setup
│   │   ├── scraper-worker.js # Job processor
│   │   └── python-executor.js # Python script wrapper
│   ├── services/
│   │   ├── email.js          # Email notifications
│   │   └── ical.js           # iCal availability checker
│   ├── python/
│   │   ├── search_listings.py # PyAirbnb search wrapper
│   │   ├── get_listing.py    # PyAirbnb details wrapper
│   │   └── get_calendar.py   # PyAirbnb calendar wrapper
│   ├── scheduler/
│   │   └── index.js          # Cron scheduler
│   └── utils/
│       └── logger.js         # Winston logger
├── package.json
├── requirements.txt          # Python dependencies
├── .env.example
└── README.md
```

## Subscription Limits

### Basic ($4.99/month)
- 1 search alert
- Daily email notifications
- Full search filtering

### Premium ($14.99/month)
- 10 search alerts
- Instant notifications (every 15 min)
- Priority processing
- Full search filtering

## Development Tips

### Testing Python Scripts

```bash
# Test search
cd src/python
echo '{"check_in":"2026-03-01","check_out":"2026-03-07","ne_lat":48.9,"ne_long":2.5,"sw_lat":48.8,"sw_long":2.2}' > /tmp/input.json
python3 search_listings.py /tmp/input.json /tmp/output.json
cat /tmp/output.json
```

### Monitoring Queue

```bash
# Check Redis queue
redis-cli
> KEYS bull:airbnb-scrape:*
> LLEN bull:airbnb-scrape:wait
```

### Database Queries

```sql
-- Check active alerts
SELECT COUNT(*) FROM search_alerts WHERE is_active = true;

-- Check recent notifications
SELECT * FROM notifications ORDER BY sent_at DESC LIMIT 10;

-- Check listings found
SELECT COUNT(*) FROM listings;
```

## Optimizations

### Cost Reduction

1. **Search Deduplication**: Cache identical searches across multiple users
2. **iCal First**: Use free iCal feeds before running expensive scrapes
3. **Batch Processing**: Group similar jobs together
4. **Smart Scheduling**: Only scrape high-demand areas frequently

### Performance

1. **Database Indexes**: Already included in schema
2. **Redis Caching**: Cache search results for 1 hour
3. **Connection Pooling**: Reuse DB connections
4. **Parallel Processing**: Process multiple jobs concurrently

## Troubleshooting

### Python script fails
```bash
# Check Python installation
python3 --version
pip list | grep pyairbnb

# Test pyairbnb directly
python3 -c "import pyairbnb; print(pyairbnb.__version__)"
```

### Worker not processing jobs
```bash
# Check Redis connection
redis-cli PING

# Check queue status
node -e "import('./src/workers/queue.js').then(q => q.scrapeQueue.getJobCounts().then(console.log))"
```

### Emails not sending
- Verify EMAIL_USER and EMAIL_PASS are correct
- For Gmail: Use App Password, not regular password
- Check spam folder

## Future Enhancements

- [ ] Web frontend (React/Next.js)
- [ ] Mobile app (React Native)
- [ ] Webhook notifications
- [ ] SMS notifications (Twilio)
- [ ] Price history charts
- [ ] Saved searches
- [ ] Favorite listings
- [ ] Multi-currency support
- [ ] Analytics dashboard

## License

MIT

## Support

For issues, contact: support@example.com
