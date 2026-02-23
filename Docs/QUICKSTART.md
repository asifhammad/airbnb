# Quick Start Guide

## Local Development Setup

### 1. Install Dependencies

```bash
# Node.js dependencies
npm install

# Python dependencies (requires Python 3.8+)
pip install pyairbnb
```

### 2. Setup PostgreSQL and Redis

**Option A: Using Docker (Recommended)**

```bash
# PostgreSQL
docker run --name airbnb-postgres -e POSTGRES_PASSWORD=password -e POSTGRES_DB=airbnb_alerts -p 5432:5432 -d postgres:14

# Redis
docker run --name airbnb-redis -p 6379:6379 -d redis:6
```

**Option B: Local Installation**

Install PostgreSQL and Redis on your system, then create database:

```sql
CREATE DATABASE airbnb_alerts;
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/airbnb_alerts
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key-change-this
EMAIL_USER=your-gmail@gmail.com
EMAIL_PASS=your-app-password
```

**For Gmail:**
1. Go to Google Account → Security → 2-Step Verification
2. Generate App Password
3. Use that password in EMAIL_PASS

### 4. Run Database Migrations

```bash
npm run migrate
```

### 5. Start Services

**Terminal 1 - API Server:**
```bash
npm run dev
```

**Terminal 2 - Worker:**
```bash
npm run worker
```

## Test the API

### 1. Register a User

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
```

Save the `token` from response.

### 2. Create a Search Alert

```bash
curl -X POST http://localhost:3000/api/alerts/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -d '{
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
  }'
```

### 3. Get Your Alerts

```bash
curl http://localhost:3000/api/alerts \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## Railway Deployment

### 1. Create Railway Project

1. Go to [Railway](https://railway.app)
2. Create new project
3. Add PostgreSQL database
4. Add Redis database

### 2. Deploy Services

**Service 1: API**
- Connect GitHub repo
- Root directory: `/`
- Start command: `node src/index.js`
- Add environment variables from Railway DB

**Service 2: Worker**
- Same repo
- Root directory: `/`
- Start command: `node src/workers/scraper-worker.js`
- Share environment variables with API service

### 3. Environment Variables

Set these in Railway (auto-populated from database addons):
- `DATABASE_URL` ✅ (from PostgreSQL addon)
- `REDIS_URL` ✅ (from Redis addon)

Add manually:
- `NODE_ENV=production`
- `JWT_SECRET=your-secret`
- `EMAIL_USER=your-email`
- `EMAIL_PASS=your-app-password`
- `EMAIL_FROM=Airbnb Alerts <noreply@example.com>`
- `PYTHON_PATH=python3`
- `TEMP_DIR=/tmp`

## Common Issues

### "Cannot find module 'pyairbnb'"

```bash
pip install pyairbnb --break-system-packages
# or
pip3 install pyairbnb
```

### "Redis connection refused"

Make sure Redis is running:
```bash
redis-cli ping
# Should return: PONG
```

### Worker not processing jobs

Check Redis queue:
```bash
redis-cli
> KEYS bull:*
> LLEN bull:airbnb-scrape:wait
```

### Database connection error

Verify DATABASE_URL format:
```
postgresql://username:password@host:port/database
```

## Next Steps

1. ✅ Test the API locally
2. ✅ Deploy to Railway
3. ✅ Set up email notifications
4. 🚀 Build a frontend (React/Next.js)
5. 📱 Create mobile app
6. 💰 Add payment integration (Stripe)

## Need Help?

Check the main [README.md](README.md) for full documentation.
