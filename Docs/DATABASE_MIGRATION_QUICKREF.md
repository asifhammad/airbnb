# Database Migration Quick Reference

## One-Time Setup Commands

```bash
# 1. Prepare environment
cp .env.migration.example .env.local
# Edit .env.local with your Supabase and Railway connection strings

# 2. Backup existing database (CRITICAL!)
pg_dump DATABASE_REPLICA_URL > railway_backup_$(date +%Y%m%d_%H%M%S).sql

# 3. Run migration
npm run migrate:to-supabase

# 4. Verify migration was successful
cat src/db/migration-log-*.json | jq '.status'  # Should show "completed"

# 5. Setup replication
npm run setup:replication

# 6. Check health
npm run db:health
```

## Daily Operations

### Check Database Health
```bash
npm run db:health
```

Expected output:
```
🟢 Overall: healthy

Primary (Supabase):
  ✅ Status: healthy
  ⏱️  Latency: 45ms

Replica (Railway):
  ✅ Status: healthy
  ⏱️  Latency: 52ms
```

### Monitor Replication
```sql
-- On Supabase (primary)
SELECT slot_name, active, restart_lsn FROM pg_replication_slots;

-- On Railway (replica)
SELECT subname, subenabled FROM pg_subscription;
SELECT NOW() - pg_last_xact_replay_timestamp() AS replication_lag;
```

### Check Replication Lag via psql
```bash
# Connect to primary (Supabase)
psql "postgresql://user:password@db.supabase.co:5432/postgres"
> SELECT * FROM pg_stat_replication;
```

## Troubleshooting Commands

### Test Write Propagation
```bash
# On primary (Supabase) - insert test data
psql "postgresql://user:password@db.supabase.co:5432/postgres" \
  -c "INSERT INTO users (email) VALUES ('test_$(date +%s)@example.com');"

# Wait a moment for replication
sleep 1

# On replica (Railway) - check if it appears
psql "postgresql://user:password@railway-db.railway.app:5432/railway" \
  -c "SELECT COUNT(*) FROM users WHERE email LIKE 'test_%@example.com';"
```

### Restart Replication (if stuck)
```bash
# On replica (Railway)
psql "postgresql://user:password@railway-db.railway.app:5432/railway"

> ALTER SUBSCRIPTION airbnb_alerts_sub DISABLE;
> ALTER SUBSCRIPTION airbnb_alerts_sub ENABLE;

-- Check status
> SELECT subenabled FROM pg_subscription WHERE subname = 'airbnb_alerts_sub';
```

### Check Connection Pools
```bash
# On primary (Supabase)
psql "postgresql://user:password@db.supabase.co:5432/postgres"

> SELECT 
    datname,
    count(*) as connections
  FROM pg_stat_activity
  GROUP BY datname;

> SELECT setting FROM pg_settings WHERE name = 'max_connections';
> SELECT setting FROM pg_settings WHERE name = 'max_wal_senders';
```

## Environment Variables Quick Reference

```bash
# Required
DATABASE_URL=postgresql://user:password@host:5432/database

# Optional (enable after migration)
DATABASE_REPLICA_URL=postgresql://user:password@host:5432/database

# Performance tuning
DB_PRIMARY_POOL_SIZE=10
DB_REPLICA_POOL_SIZE=10

# Health monitoring
HEALTH_CHECK_INTERVAL=30000
HEALTH_CHECK_WARNING_THRESHOLD=100
HEALTH_CHECK_CRITICAL_THRESHOLD=500
```

## NPM Scripts

| Command | Purpose |
|---------|---------|
| `npm run migrate` | Run standard migrations on primary |
| `npm run migrate:to-supabase` | Migrate data from Railway to Supabase |
| `npm run setup:replication` | Setup logical replication |
| `npm run db:health` | Check database health status |
| `npm start` | Start application (uses new config) |
| `npm run dev` | Development mode (uses new config) |

## Files Overview

| File | Purpose |
|------|---------|
| `src/db/config.js` | Connection management (primary + replica) |
| `src/db/migrate-to-supabase.js` | Data migration script |
| `src/db/setup-replication.js` | Replication initialization |
| `src/db/health-check.js` | Health monitoring utilities |
| `MIGRATION_SETUP.md` | Detailed setup guide |
| `.env.migration.example` | Environment template |

## Import Changes Required

**Update any files that import from `src/db/index.js`:**

```javascript
// OLD
import { query, migrate, getClient } from './db/index.js';

// NEW
import * as db from './db/config.js';

// Usage stays mostly the same, but now supports routing:
await db.query('SELECT ...', params);           // Auto-routes
await db.queryPrimary('INSERT ...', params);    // Force primary
await db.queryReplica('SELECT ...', params);    // Force replica
```

## Rollback Steps

If something goes wrong:

```bash
# 1. Stop application
# 2. Restore from backup
psql postgresql://user:password@railway-db.railway.app:5432/railway < railway_backup_*.sql

# 3. Revert code changes
git revert <migration-commit-hash>

# 4. Redeploy
npm install
npm start
```

## Performance Expectations

After migration, expect:
- **Write latency**: +10-20ms (waiting for primary acknowledgment)
- **Read latency**: -5-30% (reads from closer replica, if configured)
- **Replication lag**: <100ms under normal load
- **Overall throughput**: +20-40% (better scaling with read replica)

## Monitoring Checklist (First 48 Hours)

- [ ] Replication lag < 100ms
- [ ] No connection errors in logs
- [ ] Write latency stable
- [ ] Read latency improved or stable
- [ ] Health checks passing
- [ ] User transactions completing normally
- [ ] No data inconsistencies reported

## Emergency Contacts

- **Supabase Support**: https://app.supabase.com/support
- **Railway Support**: https://railway.app (dashboard or email)
- **PostgreSQL Docs**: https://www.postgresql.org/docs/

## Additional Resources

- [Supabase Replication Docs](https://supabase.com/docs/guides/database/replication)
- [PostgreSQL Logical Replication](https://www.postgresql.org/docs/current/logical-replication.html)
- [PostgreSQL Monitoring](https://www.postgresql.org/docs/current/monitoring.html)
