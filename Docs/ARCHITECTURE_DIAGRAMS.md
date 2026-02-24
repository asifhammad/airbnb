# Architecture & Setup Diagrams

## Current Architecture (Before Migration)

```
┌─────────────────────────────┐
│   Alert Buzz App         │
│  (Node.js / Express)        │
└──────────────┬──────────────┘
               │
               ▼
        ┌──────────────┐
        │ PostgreSQL   │
        │  (Railway)   │
        │              │
        │ - All Data   │
        │ - All Writes │
        │ - All Reads  │
        └──────────────┘
```

**Issues:**
- ❌ Single point of failure
- ❌ All load on Railway
- ❌ No backup for reads
- ❌ Limited scalability

---

## Target Architecture (After Migration)

```
┌──────────────────────────────────────────────────────┐
│           Alert Buzz Application                  │
│              (src/db/config.js)                      │
│                                                      │
│  Smart Query Router:                                │
│  - Writes → Primary (Supabase)                      │
│  - Reads → Replica (Railway) [if available]         │
│  - Fallback → Primary [if replica down]             │
└──────────────────┬───────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
        ▼                     ▼
  ┌───────────────┐    ┌──────────────┐
  │   Primary DB  │    │  Replica DB  │
  │  (Supabase)   │    │  (Railway)   │
  │               │    │              │
  │ - Writes Only │───▶│ - Reads Only │
  │ - Master Data │    │ - Read-Only  │
  │ - Source of   │    │ - Fallback   │
  │   Truth       │    │ - Load Share │
  └───────────────┘    └──────────────┘
        ▲                     ▲
        │                     │
        │   Logical Replication
        │   (Continuous Sync)
        │                     │
        └─────────────────────┘

Legend:
─▶  = Writes (INSERT, UPDATE, DELETE)
→   = Reads (SELECT)
···→ = Replication Stream
```

**Benefits:**
- ✅ High availability (replica as backup)
- ✅ Better read performance (distributed)
- ✅ Load balancing across databases
- ✅ Transparent to application
- ✅ Graceful degradation

---

## Connection Flow

### Write Operation
```
Application
    │
    ├─ Query: INSERT INTO users ...
    │
    ▼
db.query() [Auto-detects write]
    │
    ▼
config.js [Routes to Primary]
    │
    ▼
Supabase (Primary)
    │
    └──▶ (Replicates asynchronously)
            │
            ▼
        Railway (Replica)
```

### Read Operation
```
Application
    │
    ├─ Query: SELECT * FROM users WHERE id = 1
    │
    ▼
db.query() [Auto-detects read]
    │
    ▼
config.js [Routes to Replica if available]
    │
    ├─ Replica Available? ──Yes──▶ Railway (Replica) ──▶ ✅ Fast
    │
    └─ Replica Down? ─────Yes──▶ Supabase (Primary) ──▶ ⚠️  Fallback
```

---

## Migration Timeline

```
DAY 1: Preparation
├─ Get Supabase connection string
├─ Prepare Railway backup
└─ Configure environment variables
   │
   ▼
   └─ npm run migrate:to-supabase
      └─ Data Transfer (10-30 min)
         └─ Verify: ✅ 100% match
            │
            ▼
DAY 1-2: Replication Setup
├─ Enable replication on Supabase
├─ npm run setup:replication
│  └─ Create publication/subscription
│     └─ Verify: ✅ Replication active
│
├─ Update application code
│  └─ Switch from src/db/index.js to src/db/config.js
│
├─ Staging deployment
│  └─ Test for 24-48 hours
│     └─ Monitor: ✅ Lag < 100ms
│
├─ Production deployment
│  └─ Gradual rollout (if needed)
│
└─ Production monitoring
   └─ Verify: ✅ All metrics healthy
```

---

## Component Dependencies

```
┌─────────────────────────────────────────┐
│         Application Code                │
│  (src/index.js, routes, services)       │
└────────┬────────────────────────────────┘
         │ imports
         ▼
┌─────────────────────────────────────────┐
│      src/db/config.js                   │
│  (Connection management)                 │
├─────────────────────────────────────────┤
│  ├─ query()                             │
│  ├─ queryPrimary()                      │
│  ├─ queryReplica()                      │
│  ├─ getConnectionStatus()               │
│  └─ waitForDb()                         │
└────┬──────────────────────┬─────────────┘
     │                      │
     ├─ imports            ├─ imports
     │                      │
     ▼                      ▼
┌──────────────┐    ┌──────────────────┐
│   pg Pool    │    │   pg Pool        │
│ (Primary)    │    │ (Replica)        │
│ Supabase     │    │ Railway          │
└──────────────┘    └──────────────────┘


Optional: Health Monitoring
┌──────────────────────────┐
│  src/db/health-check.js  │
│  (Monitoring)            │
├──────────────────────────┤
│  ├─ check()              │
│  ├─ generateReport()     │
│  ├─ startMonitor()       │
│  └─ healthCheckMiddleware│
└────────┬────────┬────────┘
         │        │
         └────────┴──────▶ Express middleware
                         for /health endpoint
```

---

## Query Routing Decision Tree

```
                      ┌─ db.query(sql, params)
                      │
                      ▼
              Is query a WRITE?
              (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP)
              │
         Yes ├─────────────────────────▶ Use PRIMARY (Supabase)
              │                                │
              │                                ▼
              │                         Execute on Primary
              │                                │
         No   │                                ▼
              ├─────────────────────────▶ Replica Available?
                                              │
                                          Yes ├─ Use REPLICA (Railway)
                                              │        │
                                              │        ▼
                                              │   Execute on Replica
                                              │
                                          No  └─ Use PRIMARY (Supabase)
                                                      │
                                                      ▼
                                               Fallback to Primary
                                                      │
                                                      ▼
                                               Return results
```

---

## Data Flow During Replication

```
TIME ──────────────────────────────────────▶

Application writes to Supabase:
│ INSERT INTO users (email) VALUES ('user@example.com')
▼
                    ┌─────────────────────────┐
                    │   Supabase (Primary)    │
                    │                         │
         ┌─────────▶│ Data committed ✅       │
         │          │                         │
         │          └─────────────────────────┘
         │                    │
    ┌────┘                    │ Logical Replication
    │                         │ (WAL changes)
    │                         ▼
    │          ┌─────────────────────────┐
    │          │  PostgreSQL Replication │
    │          │       Slot              │
    │          └────────┬────────────────┘
    │                   │
    │                   ▼
    │          ┌─────────────────────────┐
    │          │ Railway (Replica)       │
    │          │                         │
    └─────────▶│ Data applied ✅         │
  (within     │                         │
   100ms)    └─────────────────────────┘
  typically

Application can immediately read from Replica:
│ SELECT * FROM users WHERE email = 'user@example.com'
▼
Should find the data (< 100ms old typically)
```

---

## Failover Scenario

```
SCENARIO 1: Replica Dies
─────────────────────────

┌─────────────┐         ┌──────────────┐
│  Supabase   │   ✅   │   Railway    │  ❌
│  Primary    │────────│  Replica     │  DOWN
└─────────────┘    ✅  └──────────────┘

Application:
│ await db.query('SELECT * FROM users')
│
▼
config.js:
├─ This is a READ
├─ Try Replica ──▶ ❌ FAILS (CONNECTION ERROR)
│
└─ Fallback to Primary ──▶ Supabase
                            │
                            ▼
                        ✅ DATA RETURNED
                        (from Supabase)

Result: Application continues working seamlessly
Latency: Slightly higher (no nearby replica)
User Impact: None (transparent failover)


SCENARIO 2: Primary Dies
────────────────────────

┌─────────────┐         ┌──────────────┐
│  Supabase   │  ❌    │   Railway    │  ✅
│  Primary    │  DOWN  │  Replica     │
└─────────────┘        └──────────────┘

Application tries to WRITE:
│ await db.query('INSERT INTO users ...')
│
▼
config.js:
├─ This is a WRITE
├─ Route to Primary ──▶ ❌ FAILS (PRIMARY DOWN)
│
└─ No fallback available

Result: ❌ Write fails
Action: Alert team immediately
Recovery: Supabase restarts or switchover
          (See: Rollback/Recovery procedures)


SCENARIO 3: Network Partition
──────────────────────────────

Replica available but slow/unreliable:
│ await db.query('SELECT * FROM users')
│
▼
config.js (with health checks):
├─ Check Replica latency
├─ If latency > 500ms ──▶ ⚠️  WARNING
├─ If no response ──────▶ ❌ TIMEOUT
│
└─ Fallback to Primary

Result: Slower but resilient
Monitor: Health check alerts team
```

---

## Files & Directory Structure

```
airbnb-alerts/
│
├─ package.json (UPDATED with scripts)
│
├─ MIGRATION_SETUP.md (NEW - Full guide)
├─ MIGRATION_IMPLEMENTATION.md (NEW - This summary)
├─ DATABASE_MIGRATION_QUICKREF.md (NEW - Quick commands)
├─ .env.migration.example (NEW - Template)
│
├─ src/
│  │
│  ├─ db/
│  │  ├─ index.js (EXISTING - Keep for reference)
│  │  ├─ config.js (NEW - Use this instead)
│  │  ├─ migrate.js (EXISTING - Standard migrations)
│  │  ├─ migrate-to-supabase.js (NEW - Data migration)
│  │  ├─ setup-replication.js (NEW - Replication setup)
│  │  ├─ health-check.js (NEW - Health monitoring)
│  │  ├─ schema.sql (EXISTING)
│  │  └─ migration-log-*.json (AUTO - Migration results)
│  │
│  ├─ index.js (NEEDS UPDATE - Change import)
│  ├─ routes/
│  ├─ services/
│  ├─ middleware/
│  ├─ workers/
│  ├─ utils/
│  └─ python/
│
└─ [other files unchanged]
```

---

## Resource Requirements

```
┌────────────────┬─────────────┬──────────────┐
│ Phase          │ Time        │ Resources    │
├────────────────┼─────────────┼──────────────┤
│ Setup          │ 15 min      │ Terminal     │
│ Migration      │ 10-30 min   │ Network      │
│ Replication    │ 5 min       │ Root access  │
│ Testing        │ 1-2 hours   │ Staging env  │
│ Rollout        │ 24-48 hours │ Monitoring   │
├────────────────┼─────────────┼──────────────┤
│ TOTAL          │ 2-3 days    │ As above     │
└────────────────┴─────────────┴──────────────┘
```

---

## Success Criteria

```
✅ Phase 1 Success:
   - All env vars configured
   - Connection strings validated

✅ Phase 2 Success:
   - Migration logs show "completed"
   - Row counts match (100%)
   - No errors in error array

✅ Phase 3 Success:
   - Publication created
   - Subscription active
   - Replication lag < 100ms

✅ Phase 4 Success:
   - Code updated
   - Tests pass locally
   - No compilation errors

✅ Phase 5 Success:
   - Staging deployment successful
   - Queries work on staging
   - No data inconsistencies

✅ Phase 6 Success:
   - Production deployment successful
   - Monitoring shows health
   - User traffic flowing normally
   - Replication lag stable
```

---

## Next Steps

1. **Read**: MIGRATION_SETUP.md (complete guide)
2. **Prepare**: Get Supabase connection string
3. **Execute**: Follow the step-by-step guide
4. **Monitor**: Use health checks and logs
5. **Maintain**: Regular monitoring after migration

**Questions?** See troubleshooting section in MIGRATION_SETUP.md
