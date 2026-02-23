# Database Migration Execution Checklist

## Pre-Migration (Do These First!)

### Planning & Preparation
- [ ] **Review all documentation**
  - [ ] Read MIGRATION_SETUP.md completely
  - [ ] Review ARCHITECTURE_DIAGRAMS.md
  - [ ] Understand current database structure

- [ ] **Get credentials & URLs**
  - [ ] Supabase project created
  - [ ] Supabase connection string (check: includes password & sslmode)
  - [ ] Railway connection string (check: includes password)
  - [ ] Test credentials work locally

- [ ] **Backup existing data**
  - [ ] pg_dump backup of Railway database created
  - [ ] Backup file verified (not 0 bytes)
  - [ ] Backup stored in secure location
  - [ ] Backup retention policy documented (30+ days)

### Environment Setup
- [ ] **Configure environment**
  - [ ] Copy .env.migration.example to .env.local
  - [ ] Update DATABASE_URL (Supabase primary)
  - [ ] Update DATABASE_REPLICA_URL (Railway replica)
  - [ ] Test both connection strings locally:
    ```bash
    psql "postgresql://..." -c "SELECT 1"
    ```

- [ ] **Verify prerequisites**
  - [ ] Node.js 16+ installed (`node --version`)
  - [ ] npm installed (`npm --version`)
  - [ ] psql client installed (for manual debugging)
  - [ ] Dependencies installed (`npm install`)

---

## Phase 1: Environment Configuration ✅

### Database Verification
- [ ] **Primary (Supabase)**
  - [ ] Instance created
  - [ ] Connection confirmed
  - [ ] PostgreSQL version checked (10+)
  - [ ] Logical replication supported
  - [ ] Disk space available (check target size)

- [ ] **Replica (Railway)**
  - [ ] Instance running
  - [ ] Connection confirmed
  - [ ] PostgreSQL version checked (10+)
  - [ ] Current data size known
  - [ ] Backup completed

### Local Testing
- [ ] **Test connections in code**
  ```bash
  npm run db:health
  # Should show both connected or replica unavailable
  ```

- [ ] **Verify migrations script**
  ```bash
  npm run migrate
  # Should complete without errors on existing schema
  ```

---

## Phase 2: Data Migration 🚀

### Pre-Migration Checks
- [ ] **Database state verified**
  - [ ] Current record counts documented:
    ```bash
    psql $DATABASE_REPLICA_URL -c "SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) FROM pg_tables WHERE schemaname = 'public' ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;"
    ```
  - [ ] All tables accessible
  - [ ] No active transactions causing locks
  - [ ] Database in consistent state

- [ ] **Team notified**
  - [ ] Team informed of migration timing
  - [ ] No concurrent schema changes expected
  - [ ] Monitoring team on standby

### Migration Execution
- [ ] **Run migration script**
  ```bash
  export DATABASE_REPLICA_URL="postgresql://..."  # Railway
  export DATABASE_URL="postgresql://..."          # Supabase
  npm run migrate:to-supabase
  # Watch for: ✅ Connected messages
  #            ✅ Completed messages
  #            ✅ Row counts match
  ```

- [ ] **Monitor migration**
  - [ ] No errors in output (warnings about duplicates OK)
  - [ ] Script completes successfully
  - [ ] Migration log generated

### Post-Migration Verification
- [ ] **Check migration results**
  - [ ] Find latest log: `ls -lrt src/db/migration-log-*.json | tail -1`
  - [ ] Verify status: `jq '.status' migration-log-*.json` → "completed"
  - [ ] Check for errors: `jq '.errors' migration-log-*.json` → [] (empty)
  - [ ] Verify table counts:
    ```bash
    jq '.tables | to_entries[] | "\(.key): \(.value.inserted) rows"' migration-log-*.json
    ```

- [ ] **Manual verification in Supabase**
  ```bash
  psql "postgresql://..."  # Supabase connection
  \dt  # List tables
  SELECT COUNT(*) FROM users;
  SELECT COUNT(*) FROM search_alerts;
  # Compare with Railway counts
  ```

- [ ] **Spot check data**
  - [ ] Sample random users from both databases
  - [ ] Compare a search alert with all details
  - [ ] Verify JSON columns (amenities) preserved
  - [ ] Check timestamp accuracy

---

## Phase 3: Replication Setup 🔄

### Pre-Replication Checks
- [ ] **Verify Supabase replication support**
  - [ ] Contact Supabase if logical replication not enabled
  - [ ] Or use Supabase docs to enable it
  - [ ] Verify in Supabase dashboard: Settings → Database

- [ ] **Confirm Railway is ready**
  - [ ] Railway database connection still valid
  - [ ] Rails has disk space for incoming data
  - [ ] No issues from migration process

### Replication Setup Execution
- [ ] **Run replication setup script**
  ```bash
  npm run setup:replication
  # Watch for: ✅ Publication created
  #            ✅ Subscription created
  #            ✅ Replication active
  ```

- [ ] **Verify replication started**
  - [ ] No errors in output
  - [ ] Script completes successfully
  - [ ] Shows "Active" replication slots

### Post-Setup Verification
- [ ] **Check replication status**
  ```bash
  npm run db:health
  # Verify:
  # - Primary: ✅ Healthy
  # - Replica: ✅ Healthy
  # - Latency: < 100ms each
  ```

- [ ] **Monitor replication lag**
  - [ ] Check lag < 50ms (target)
  - [ ] Lag stable (not growing)
  - [ ] No error messages

- [ ] **Test replication works**
  - [ ] Insert test data into Supabase
  - [ ] Wait 1-2 seconds
  - [ ] Query Railway replica for same data
  - [ ] Verify data appears

---

## Phase 4: Code Integration 💻

### Update Application Code
- [ ] **Update imports**
  - [ ] Find all `import ... from './db/index.js'`
  - [ ] Change to: `import * as db from './db/config.js'`
  - [ ] Or: `import db from './db/config.js'`

- [ ] **Verify exports still work**
  - [ ] `db.query()` available
  - [ ] `db.queryPrimary()` available
  - [ ] `db.queryReplica()` available
  - [ ] All existing calls still valid

- [ ] **Update migrations (if using migrate.js)**
  - [ ] Change: `const { query } = require('./index.js')`
  - [ ] To: `const db = require('./config.js')`
  - [ ] Update calls to: `db.queryPrimary()`

- [ ] **Add health check endpoint** (optional)
  ```javascript
  import { healthCheckMiddleware } from './db/health-check.js';
  app.get('/health', healthCheckMiddleware);
  ```

- [ ] **Add monitoring** (optional)
  ```javascript
  import { startHealthCheckMonitor } from './db/health-check.js';
  startHealthCheckMonitor(30000);  // Every 30 seconds
  ```

### Local Testing
- [ ] **Application starts**
  ```bash
  npm start
  # Should connect to both databases
  # Watch for: "✅ Database connection established"
  ```

- [ ] **Queries work**
  - [ ] Test INSERT: `curl -X POST /api/users -d '{"email":"test@example.com"}'`
  - [ ] Test SELECT: `curl /api/users`
  - [ ] Test UPDATE: works
  - [ ] Test DELETE: works

- [ ] **Fallback works**
  - [ ] Temporarily break DATABASE_REPLICA_URL
  - [ ] Restart application
  - [ ] Verify reads still work (fallback to primary)

- [ ] **No console errors**
  - [ ] npm start output clean
  - [ ] No unhandled promise rejections
  - [ ] No connection warnings

---

## Phase 5: Staging Testing 🧪

### Deployment to Staging
- [ ] **Prepare staging environment**
  - [ ] Staging has updated .env
  - [ ] Staging uses Supabase (primary) + Railway (replica)
  - [ ] Staging monitoring configured

- [ ] **Deploy code changes**
  - [ ] All code changes committed
  - [ ] Push to staging branch
  - [ ] CI/CD pipeline passes (if applicable)
  - [ ] Staging deployment complete

- [ ] **Verify staging health**
  - [ ] Application starts successfully
  - [ ] `/health` endpoint shows both DBs connected
  - [ ] No error logs in first minute

### Functional Testing (24-48 Hours)
- [ ] **Basic functionality**
  - [ ] Create user account
  - [ ] Create search alert
  - [ ] Test notifications
  - [ ] Modify alert settings
  - [ ] Delete alert

- [ ] **Data consistency**
  - [ ] Write to primary (Supabase)
  - [ ] Immediately read from staging (uses replica)
  - [ ] Data appears correctly
  - [ ] No duplicates
  - [ ] No missing data

- [ ] **Performance**
  - [ ] Record baseline query times
  - [ ] Reads should be ≈ same or faster
  - [ ] Writes should be ≈ same (maybe +10-20ms)
  - [ ] No noticeable slowdown

- [ ] **Monitoring**
  - [ ] Replication lag < 100ms (consistently)
  - [ ] Health checks passing
  - [ ] Error rates normal
  - [ ] No connection exhaustion

- [ ] **Stress test** (optional, if applicable)
  - [ ] Simulate traffic surge
  - [ ] Monitor connection pools
  - [ ] Verify no exhaustion
  - [ ] Replication lag remains acceptable

### Issues & Fixes
- [ ] **If replication lag high:**
  - [ ] Check network path: `ping Supabase` & `ping Railway`
  - [ ] Check disk space on both systems
  - [ ] Review slow queries on replica
  - [ ] Contact support if persists

- [ ] **If reads still slow:**
  - [ ] Verify replica is actually being used
  - [ ] Check replica disk I/O
  - [ ] Verify indexes exist on replica
  - [ ] Profile slow queries

- [ ] **If writes fail:**
  - [ ] Verify primary DB accessible
  - [ ] Check connection pool settings
  - [ ] Review error logs
  - [ ] Test direct psql connection to Supabase

---

## Phase 6: Production Rollout 🎯

### Pre-Production Preparation
- [ ] **Final backups**
  - [ ] Railway backup (current state)
  - [ ] Supabase backup (pre-rollout)
  - [ ] Stored securely with retention policy

- [ ] **Team ready**
  - [ ] On-call engineer available
  - [ ] Communication channels open
  - [ ] Rollback procedure documented
  - [ ] Alert/escalation process clear

- [ ] **Monitoring configured**
  - [ ] Database health checks active
  - [ ] Replication lag alerting enabled
  - [ ] Error rate monitoring active
  - [ ] Performance baselines set

### Production Deployment
- [ ] **Deploy to production**
  - [ ] Code changes merged to main
  - [ ] CI/CD pipeline passes
  - [ ] Production deployment succeeds
  - [ ] Deployment log reviewed

- [ ] **Verify production health**
  ```bash
  # Check from monitoring dashboard
  # - Primary: ✅ Healthy
  # - Replica: ✅ Connected
  # - Replication lag: < 100ms
  # - Error rate: Normal
  ```

- [ ] **Monitor first hour**
  - [ ] Watch error logs continuously
  - [ ] Monitor replication lag
  - [ ] Track query performance
  - [ ] Check user-facing metrics

### Traffic Monitoring (Next 24-48 Hours)
- [ ] **Continuous monitoring**
  - [ ] Replication lag stable (< 100ms)
  - [ ] No connection pool exhaustion
  - [ ] Query latencies normal
  - [ ] Error rates baseline
  - [ ] Uptime: 100%

- [ ] **User-reported issues**
  - [ ] No data loss reports
  - [ ] No missing notifications
  - [ ] No duplicate data
  - [ ] No performance complaints

- [ ] **Daily checks**
  - [ ] `npm run db:health` passing
  - [ ] Replication metrics healthy
  - [ ] Backup strategy working
  - [ ] No unexplained errors

---

## Post-Migration (Ongoing)

### Week 1
- [ ] **Daily health checks**
  - [ ] Review logs for errors
  - [ ] Monitor replication lag
  - [ ] Check backup completeness
  - [ ] Verify monitoring alerts work

- [ ] **Performance optimization**
  - [ ] Profile slow queries
  - [ ] Add missing indexes if needed
  - [ ] Adjust connection pool sizes
  - [ ] Tune replication settings

### Week 2-4
- [ ] **Decommission old infrastructure** (OPTIONAL)
  - [ ] Confirm no need to revert
  - [ ] After 30 days, can delete Railway instance
  - [ ] Keep backup for additional 30 days
  - [ ] Document in runbooks

### Ongoing
- [ ] **Weekly reviews**
  - [ ] Check replication health
  - [ ] Review performance metrics
  - [ ] Verify backups completing
  - [ ] Test failover scenarios

- [ ] **Monthly maintenance**
  - [ ] Vacuum/analyze databases
  - [ ] Review slow query logs
  - [ ] Audit connection pools
  - [ ] Update runbooks if needed

---

## Troubleshooting Decision Tree

```
Problem: Migration failed

├─ Check: Migration log file
│  ├─ Status: "failed" → See error in file
│  └─ Status: "completed" but some errors
│     └─ See "errors" array in log
│
├─ If: Connection error
│  ├─ Action: Verify connection strings
│  ├─ Action: Check credentials
│  └─ Action: Verify IP whitelisting
│
├─ If: Permission error (INSERT fails)
│  ├─ Action: Verify user has INSERT permission
│  └─ Action: Check foreign key constraints
│
└─ If: Schema mismatch
   ├─ Action: Run src/db/migrate.js first
   └─ Action: Compare schema on both DBs
```

```
Problem: Replication lag > 500ms

├─ Check: Network connectivity
│  └─ `ping <Supabase IP>` and `ping <Railway IP>`
│
├─ Check: Replica disk space
│  └─ `psql ... -c "SELECT pg_database_size(datname)/1024/1024 AS MB FROM pg_database WHERE datname='railway';"`
│
├─ Check: Replica load
│  └─ `top` or monitoring dashboard
│
└─ Action: Contact support if persists
```

```
Problem: Writes failing in production

├─ CRITICAL: Primary database is down
│  └─ Action: IMMEDIATE - Page on-call team
│     └─ Action: Switch to Railway-only (rollback)
│
├─ Or: Connection pool exhausted
│  └─ Action: Increase DB_PRIMARY_POOL_SIZE
│  └─ Action: Restart application
│
└─ Or: Network connectivity issue
   └─ Action: Verify VPC/firewall settings
```

---

## Rollback Plan

### Quick Rollback (< 30 minutes)
```bash
# 1. Revert code changes
git revert <migration-commit>
npm install

# 2. Stop using Supabase in env
unset DATABASE_URL
unset DATABASE_REPLICA_URL

# 3. Switch back to Railway only
export DATABASE_URL="postgresql://..."  # Railway

# 4. Restart application
npm start

# 5. Verify traffic flowing
curl http://localhost:3000/api/users
```

### Full Restore (from backup)
```bash
# 1. Stop application
# 2. Restore Railway from backup
pg_dump railway_backup_*.sql | psql "postgresql://..."

# 3. Restart with old config
# 4. Verify data integrity
# 5. Notify team
```

---

## Sign-Off

### Migration Coordinator: _______________  Date: ___________

### QA Lead: ___________________________  Date: ___________

### DevOps Lead: _______________________  Date: ___________

### Product Manager: ____________________  Date: ___________

---

**Notes:**
(Use this space to document any deviations, issues, or special circumstances)

```




```
