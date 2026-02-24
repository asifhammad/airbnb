# Database Migration Guide: Railway → Supabase with Read Replica

This guide walks you through migrating your PostgreSQL database from Railway to Supabase, with Railway becoming a read replica for distributed load handling.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Application                               │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        │                             │
        ▼                             ▼
   [Primary DB]               [Read Replica DB]
   (Supabase)                 (Railway)
   - All Writes               - Read-only queries
   - Schema source            - Distributes read load
   - Source of truth          - Optional fallback
```

### Key Points:
- **Primary**: Supabase (all INSERT/UPDATE/DELETE operations)
- **Read Replica**: Railway (SELECT queries that can tolerate slight staleness)
- **Replication**: Logical replication from Supabase → Railway
- **Failover**: Automatic fallback to primary if replica is unavailable

## Prerequisites

1. **Supabase Account**
   - Create a new PostgreSQL database on Supabase
   - Get the connection string (with password)
   - Ensure replication is enabled (usually default)

2. **Railway Database**
   - Keep your existing Railway PostgreSQL instance (this becomes the replica)
   - Get the connection string

3. **Environment Setup**
   - Node.js 16+
   - PostgreSQL client tools (optional, for manual debugging)

## Step-by-Step Migration Process

### Phase 1: Environment Configuration

#### 1. Update your `.env` file:

```bash
# Primary database (Supabase)
DATABASE_URL=postgresql://user:password@db.supabase.co:5432/postgres

# Read replica (Railway) - will be set up after migration
DATABASE_REPLICA_URL=postgresql://user:password@railway-db.railway.app:5432/railway

# Database pool sizes (optional)
DB_PRIMARY_POOL_SIZE=10
DB_REPLICA_POOL_SIZE=10

# Node environment
NODE_ENV=production
```

**Important**: Store these in a secure location (use Railway's or Vercel's secret management)

#### 2. For Development:
Create a `.env.local` or `.env.development` with test credentials:

```bash
DATABASE_URL=postgresql://localhost:5432/airbnb_alerts_primary
DATABASE_REPLICA_URL=postgresql://localhost:5432/airbnb_alerts_replica
NODE_ENV=development
```

### Phase 2: Initial Data Migration

#### 1. Pre-Migration Backup (CRITICAL)

Before starting, create backups of both databases:

```bash
# Backup existing Railway database
pg_dump postgresql://user:password@railway-db.railway.app:5432/railway > railway_backup.sql

# After migration, keep this backup for 30 days minimum
```

#### 2. Prepare Supabase

1. Create a new PostgreSQL instance on Supabase
2. Get the connection string
3. Do NOT run migrations yet - let the migration script handle it

#### 3. Run the Migration Script

```bash
# Set environment variables
export DATABASE_REPLICA_URL="postgresql://user:password@railway-db.railway.app:5432/railway"  # Source
export DATABASE_URL="postgresql://user:password@db.supabase.co:5432/postgres"  # Target

# Run migration
npm run migrate:to-supabase

# Or with specific tables (optional):
npm run migrate:to-supabase -- --tables=users,search_alerts
```

**What this does:**
- ✅ Verifies connectivity to both databases
- ✅ Creates schema on Supabase if needed
- ✅ Exports data from Railway in batches
- ✅ Inserts data into Supabase
- ✅ Validates row counts match
- ✅ Saves migration log with results

#### 4. Verify Migration

Check the migration log:

```bash
# Find the latest log
ls -lrt src/db/migration-log-*.json | tail -1

# View the log
cat src/db/migration-log-YYYY-MM-DDTHH-mm-ss.json | jq .
```

Expected output:
```json
{
  "status": "completed",
  "tables": {
    "users": {
      "sourceCount": 150,
      "targetCount": 150,
      "inserted": 150
    },
    // ... other tables
  },
  "errors": []
}
```

### Phase 3: Replication Setup

#### 1. Enable Replication on Supabase

Supabase typically has replication enabled by default. Verify:

1. Go to Supabase dashboard
2. Settings → Database
3. Look for "Replication" settings
4. Ensure logical replication is enabled

Contact Supabase support if you need logical replication enabled on your instance.

#### 2. Create Replication Slot and Publication

```bash
# This script will:
# - Create a publication on Supabase (primary)
# - Create a subscription on Railway (replica)
# - Verify replication status

npm run setup:replication
```

#### 3. Monitor Replication Status

The script will show:
```
✅ Created publication: airbnb_alerts_pub
✅ Created subscription: airbnb_alerts_sub
📋 Published 6 tables
✅ Active Replication slots:
  - airbnb_alerts_slot (logical) ✅ Active
```

### Phase 4: Code Integration

#### 1. Update Database Imports

**Before:**
```javascript
// src/index.js
import { query, migrate } from './db/index.js';
```

**After:**
```javascript
// src/index.js
import * as db from './db/config.js';  // New unified config
```

#### 2. Update Query Patterns

The new config intelligently routes queries:

```javascript
// Automatic routing (recommended)
await db.query('SELECT * FROM users WHERE id = $1', [userId]);  // Uses replica

// Force primary (for reads that need latest data)
await db.query('SELECT * FROM search_alerts WHERE user_id = $1', [userId], 
  { forceWrite: true }
);

// Write operations (always use primary)
await db.query('INSERT INTO users (...) VALUES (...)', values);
```

#### 3. Update Migration Script

```javascript
// src/db/migrate.js - update to use primary connection
import * as db from './config.js';

export async function migrate() {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  const statements = schema.split(/;\s*(?:\r?\n|$)/);
  
  for (const stmt of statements) {
    try {
      await db.queryPrimary(stmt);  // Use primary for migrations
    } catch (err) {
      // Handle existing objects...
    }
  }
}
```

#### 4. Add Health Check Endpoint (Optional)

For monitoring replication health:

```javascript
// src/index.js
import { healthCheckMiddleware, startHealthCheckMonitor } from './db/health-check.js';

// Add health check endpoint
app.get('/health', healthCheckMiddleware);

// Start monitoring (every 30 seconds)
startHealthCheckMonitor(30000);
```

### Phase 5: Testing & Validation

#### 1. Write to Primary, Read from Replica

```javascript
// Test write
await db.queryPrimary(
  'INSERT INTO users (email) VALUES ($1)',
  ['test@example.com']
);

// Slight delay for replication (usually < 100ms)
await new Promise(r => setTimeout(r, 500));

// Read from replica
const result = await db.queryReplica(
  'SELECT * FROM users WHERE email = $1',
  ['test@example.com']
);

console.assert(result.rows.length > 0, 'Data should replicate to replica');
```

#### 2. Check Replication Lag

```bash
npm run db:health
# Shows:
# Primary (Supabase): ✅ Healthy, latency 50ms
# Replica (Railway): ✅ Healthy, latency 60ms, lag: <1s
```

#### 3. Fallback Testing

Simulate replica failure:

```bash
# Temporarily change DATABASE_REPLICA_URL to invalid value
# Restart app

# Should still work - falls back to primary
curl http://localhost:3000/api/users
```

### Phase 6: Gradual Rollout

#### 1. Deploy to Staging

```bash
# Deploy with new config
git add src/db/config.js src/db/migrate-to-supabase.js src/db/setup-replication.js
git commit -m "feat: add Supabase primary + Railway replica infrastructure"
git push origin feature/supabase-migration
```

#### 2. Monitor for 24-48 Hours

Check logs and metrics:
- Replication lag (target: < 100ms)
- Query latency (should be similar or better)
- Error rates (should be unchanged)

#### 3. Gradual Traffic Shift

If using load balancers:
```
Stage 1: 10% traffic to new setup
Stage 2: 50% traffic to new setup
Stage 3: 100% traffic to new setup
```

## Rollback Procedure

If issues occur:

### Option 1: Revert to Railway Only (Fastest)

```bash
# 1. Update .env
unset DATABASE_REPLICA_URL

# 2. Switch back to old config
git revert <commit-hash>

# 3. Redeploy
git push --force
```

### Option 2: Full Data Restore

```bash
# Restore from backup
psql postgresql://user:password@railway-db.railway.app:5432/railway < railway_backup.sql

# Verify
psql postgresql://user:password@railway-db.railway.app:5432/railway \
  -c "SELECT COUNT(*) FROM users;"
```

## Monitoring & Maintenance

### 1. Regular Health Checks

```bash
# Manual check
npm run db:health

# Automated (every 30 seconds)
# Configure in src/index.js
startHealthCheckMonitor(30000);
```

### 2. Replication Monitoring Queries

```sql
-- Check replication slots on primary (Supabase)
SELECT 
  slot_name,
  slot_type,
  active,
  restart_lsn,
  confirmed_flush_lsn
FROM pg_replication_slots;

-- Check subscription status on replica (Railway)
SELECT 
  subname,
  subenabled,
  subslotname,
  subconninfo
FROM pg_subscription;

-- Check replication lag
SELECT 
  NOW() - pg_last_xact_replay_timestamp() AS replication_lag;
```

### 3. Performance Monitoring

Track these metrics:
- **Write latency**: Should increase slightly (waiting for primary)
- **Read latency**: Should decrease (reading from closer replica if in same region)
- **Replication lag**: Target < 100ms, alert if > 500ms
- **Connection pool usage**: Monitor to size pools appropriately

## Troubleshooting

### Issue: Replication Lag is High (>1s)

**Causes:**
- Network latency between Supabase and Railway
- High write volume exceeding replication capacity
- Replica hardware constraints

**Solutions:**
```bash
# 1. Check network path
ping <supabase-ip>
ping <railway-ip>

# 2. Check replica write lag
SELECT * FROM pg_stat_replication;

# 3. Increase replica resources
# Contact Railway to upgrade instance

# 4. Temporarily increase batch size in config.js
# (reduces replication overhead)
```

### Issue: Replica Not Syncing Data

```sql
-- On replica, check subscription status
SELECT subname, subenabled FROM pg_subscription;

-- If disabled, re-enable
ALTER SUBSCRIPTION airbnb_alerts_sub ENABLE;

-- Check for errors
SELECT * FROM pg_subscription_rel;
```

### Issue: Connection Pool Exhaustion

```javascript
// Increase pool sizes in .env
DB_PRIMARY_POOL_SIZE=20
DB_REPLICA_POOL_SIZE=20

// Or implement connection pooling service:
// Consider using PgBouncer or similar
```

## Migration Checklist

- [ ] Supabase instance created with backups
- [ ] Railway connection strings captured
- [ ] Environment variables configured
- [ ] Railway database backed up
- [ ] Migration script run successfully
- [ ] Data verified (row counts match)
- [ ] Replication setup completed
- [ ] Health checks passing
- [ ] Code updated to use new config
- [ ] Staging environment tested
- [ ] Production deployed
- [ ] Monitoring active
- [ ] Old infrastructure kept for 30 days
- [ ] Team trained on new setup

## Files Modified/Created

**New Files:**
- `src/db/config.js` - Primary/replica connection management
- `src/db/migrate-to-supabase.js` - Data migration script
- `src/db/setup-replication.js` - Replication initialization
- `src/db/health-check.js` - Health monitoring

**Modified Files:**
- `package.json` - Added npm scripts
- Any files importing from `src/db/index.js` → update to `src/db/config.js`

## Next Steps (Optional)

1. **Implement read-write splitting at route level**
   - Critical reads use primary only
   - Non-critical reads use replica

2. **Setup alerting**
   - Slack/email alerts on replication lag > 500ms
   - Alert on replica unavailability

3. **Implement connection retry logic**
   - Auto-retry failed queries
   - Circuit breaker pattern for failing databases

4. **Performance optimization**
   - Index optimization queries
   - Query plan analysis

## Support & Questions

For issues specific to:
- **Supabase**: Visit https://app.supabase.com or contact support
- **Railway**: Visit https://railway.app or contact support
- **This setup**: Review logs in `src/db/migration-log-*.json`

## Timeline Estimate

- Phase 1 (Environment setup): 15 minutes
- Phase 2 (Data migration): 10-30 minutes (depends on data size)
- Phase 3 (Replication setup): 5 minutes
- Phase 4 (Code integration): 30 minutes
- Phase 5 (Testing): 1-2 hours
- Phase 6 (Gradual rollout): 24-48 hours

**Total: 2-3 days including monitoring**
