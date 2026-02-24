import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_PUBLICATION = process.env.REPLICATION_PUBLICATION || 'airbnb_alerts_pub';
const DEFAULT_SUBSCRIPTION = process.env.REPLICATION_SUBSCRIPTION || 'airbnb_alerts_sub';
const DEFAULT_SLOT = process.env.REPLICATION_SLOT || 'airbnb_alerts_slot';
const DEFAULT_TABLES = (process.env.REPLICATION_TABLES || '').trim();
const COPY_DATA = process.env.REPLICATION_COPY_DATA !== 'false';

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function parseTables(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => {
      if (v.includes('.')) return v;
      return `public.${v}`;
    });
}

function asSqlList(values) {
  return values.map((v) => {
    const [schema, table] = v.split('.');
    return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  }).join(', ');
}

function redactConnectionString(connectionString) {
  try {
    const u = new URL(connectionString);
    if (u.password) u.password = '***';
    return u.toString();
  } catch (_) {
    return '[invalid connection string]';
  }
}

function assertPostgresConnectionString(connectionString, envVarName) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch (_) {
    throw new Error(`${envVarName} is not a valid URL`);
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new Error(
      `${envVarName} must be a postgres connection string (postgresql://...), got protocol "${parsed.protocol}"`
    );
  }
}

class ReplicationSetup {
  constructor() {
    const primaryConnectionString = process.env.DATABASE_URL;
    const replicaConnectionString = process.env.DATABASE_REPLICA_URL;
    // Must be direct DB connection to Supabase for logical replication.
    const sourceReplicationConnString =
      process.env.SUPABASE_DIRECT_URL ||
      process.env.DATABASE_REPLICATION_SOURCE_URL ||
      primaryConnectionString;

    if (!primaryConnectionString) {
      throw new Error('DATABASE_URL (Supabase primary) is required');
    }
    if (!replicaConnectionString) {
      throw new Error('DATABASE_REPLICA_URL (Railway replica) is required');
    }

    this.primaryPool = new Pool({
      connectionString: primaryConnectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    this.replicaPool = new Pool({
      connectionString: replicaConnectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    this.sourceReplicationConnString = sourceReplicationConnString;
    assertPostgresConnectionString(this.sourceReplicationConnString, 'SUPABASE_DIRECT_URL/DATABASE_REPLICATION_SOURCE_URL');
    this.publicationName = DEFAULT_PUBLICATION;
    this.subscriptionName = DEFAULT_SUBSCRIPTION;
    this.slotName = DEFAULT_SLOT;
    this.tables = parseTables(DEFAULT_TABLES);
  }

  async log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = {
      info: '✅',
      warn: '⚠️ ',
      error: '❌',
    }[level] || '💬';
    console.log(`[${timestamp}] ${prefix} ${message}`);
  }

  async verifyConnectivity() {
    await this.log('Verifying connectivity to primary and replica...');

    const primaryClient = await this.primaryPool.connect();
    try {
      const { rows } = await primaryClient.query('SELECT current_database() AS db, version()');
      await this.log(`Primary OK: ${rows[0].db}`);
    } finally {
      primaryClient.release();
    }

    const replicaClient = await this.replicaPool.connect();
    try {
      const { rows } = await replicaClient.query('SELECT current_database() AS db, version()');
      await this.log(`Replica OK: ${rows[0].db}`);
    } finally {
      replicaClient.release();
    }
  }

  async checkReplicationSupport() {
    await this.log('Checking primary replication capability...');
    const client = await this.primaryPool.connect();
    try {
      const [{ rows: walSenders }, { rows: walLevel }] = await Promise.all([
        client.query("SELECT setting FROM pg_settings WHERE name = 'max_wal_senders'"),
        client.query("SELECT setting FROM pg_settings WHERE name = 'wal_level'"),
      ]);
      const maxWalSenders = Number.parseInt(walSenders[0]?.setting || '0', 10);
      const level = walLevel[0]?.setting || 'unknown';
      await this.log(`Primary max_wal_senders=${maxWalSenders}, wal_level=${level}`);
      if (maxWalSenders <= 0) {
        throw new Error('Primary reports max_wal_senders=0 (logical replication unavailable)');
      }
    } finally {
      client.release();
    }
  }

  async createPublication() {
    await this.log(`Ensuring publication "${this.publicationName}" exists on primary...`);
    const client = await this.primaryPool.connect();
    try {
      const pubCheck = await client.query(
        'SELECT 1 FROM pg_publication WHERE pubname = $1',
        [this.publicationName]
      );
      if (pubCheck.rows.length === 0) {
        if (this.tables.length > 0) {
          await client.query(
            `CREATE PUBLICATION ${quoteIdentifier(this.publicationName)} FOR TABLE ${asSqlList(this.tables)}`
          );
          await this.log(`Created publication for ${this.tables.length} configured table(s)`);
        } else {
          await client.query(
            `CREATE PUBLICATION ${quoteIdentifier(this.publicationName)} FOR ALL TABLES`
          );
          await this.log('Created publication FOR ALL TABLES');
        }
      } else if (this.tables.length > 0) {
        await client.query(
          `ALTER PUBLICATION ${quoteIdentifier(this.publicationName)} SET TABLE ${asSqlList(this.tables)}`
        );
        await this.log(`Updated publication table set (${this.tables.length} table(s))`);
      } else {
        await this.log('Publication already exists');
      }
    } finally {
      client.release();
    }
  }

  async createReplicationSlotIfMissing() {
    await this.log(`Ensuring replication slot "${this.slotName}" exists on primary...`);
    const client = await this.primaryPool.connect();
    try {
      const slotCheck = await client.query(
        'SELECT slot_name FROM pg_replication_slots WHERE slot_name = $1',
        [this.slotName]
      );
      if (slotCheck.rows.length === 0) {
        await client.query(
          'SELECT pg_create_logical_replication_slot($1, $2)',
          [this.slotName, 'pgoutput']
        );
        await this.log(`Created logical replication slot "${this.slotName}"`);
      } else {
        await this.log(`Replication slot "${this.slotName}" already exists`);
      }
    } finally {
      client.release();
    }
  }

  async createSubscription() {
    await this.log(`Ensuring subscription "${this.subscriptionName}" exists on replica...`);
    const client = await this.replicaPool.connect();
    try {
      const subCheck = await client.query(
        'SELECT 1 FROM pg_subscription WHERE subname = $1',
        [this.subscriptionName]
      );

      const connInfo = this.sourceReplicationConnString.replace(/'/g, "''");
      const pub = quoteIdentifier(this.publicationName);
      const sub = quoteIdentifier(this.subscriptionName);
      const slot = this.slotName.replace(/'/g, "''");
      const createSql =
        `CREATE SUBSCRIPTION ${sub} ` +
        `CONNECTION '${connInfo}' ` +
        `PUBLICATION ${pub} ` +
        `WITH (copy_data = ${COPY_DATA ? 'true' : 'false'}, create_slot = false, slot_name = '${slot}', enabled = true)`;

      if (subCheck.rows.length === 0) {
        await client.query(createSql);
        await this.log('Subscription created');
      } else {
        await this.log('Subscription already exists; refreshing publication');
        await client.query(`ALTER SUBSCRIPTION ${sub} REFRESH PUBLICATION`);
      }
    } finally {
      client.release();
    }
  }

  async verifyStatus() {
    await this.log('Verifying replication status...');

    const primaryClient = await this.primaryPool.connect();
    try {
      const slotRes = await primaryClient.query(
        `SELECT slot_name, plugin, slot_type, active, restart_lsn, confirmed_flush_lsn
         FROM pg_replication_slots
         WHERE slot_name = $1`,
        [this.slotName]
      );
      if (slotRes.rows.length === 0) {
        await this.log(`Slot "${this.slotName}" not found on primary`, 'warn');
      } else {
        const slot = slotRes.rows[0];
        await this.log(
          `Primary slot: ${slot.slot_name} active=${slot.active} confirmed_flush_lsn=${slot.confirmed_flush_lsn || 'n/a'}`
        );
      }
    } finally {
      primaryClient.release();
    }

    const replicaClient = await this.replicaPool.connect();
    try {
      const subRes = await replicaClient.query(
        `SELECT s.subname, s.subenabled, st.received_lsn, st.latest_end_lsn, st.latest_end_time
         FROM pg_subscription s
         LEFT JOIN pg_stat_subscription st ON st.subid = s.oid
         WHERE s.subname = $1`,
        [this.subscriptionName]
      );
      if (subRes.rows.length === 0) {
        await this.log(`Subscription "${this.subscriptionName}" not found on replica`, 'warn');
      } else {
        const sub = subRes.rows[0];
        await this.log(
          `Replica subscription: ${sub.subname} enabled=${sub.subenabled} latest_end_lsn=${sub.latest_end_lsn || 'n/a'} latest_end_time=${sub.latest_end_time || 'n/a'}`
        );
      }
    } finally {
      replicaClient.release();
    }
  }

  async refreshSubscription() {
    await this.log(`Refreshing subscription "${this.subscriptionName}" on replica...`);
    const client = await this.replicaPool.connect();
    try {
      await client.query(
        `ALTER SUBSCRIPTION ${quoteIdentifier(this.subscriptionName)} REFRESH PUBLICATION`
      );
      await this.log('Subscription refresh completed');
    } finally {
      client.release();
    }
  }

  async runSetup() {
    await this.log('Starting external logical replication setup...');
    await this.log(`Using source connection: ${redactConnectionString(this.sourceReplicationConnString)}`);
    await this.verifyConnectivity();
    await this.checkReplicationSupport();
    await this.createPublication();
    await this.createReplicationSlotIfMissing();
    await this.createSubscription();
    await this.verifyStatus();
    await this.log('Replication setup completed');
  }

  async runVerify() {
    await this.log('Running replication verification only...');
    await this.verifyConnectivity();
    await this.verifyStatus();
    await this.log('Replication verification completed');
  }

  async close() {
    await Promise.allSettled([
      this.primaryPool.end(),
      this.replicaPool.end(),
    ]);
  }
}

function parseMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith('--mode='));
  if (!modeArg) return 'setup';
  return modeArg.split('=')[1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = parseMode(process.argv.slice(2));
  const setup = new ReplicationSetup();

  (async () => {
    try {
      if (mode === 'verify') {
        await setup.runVerify();
      } else if (mode === 'refresh') {
        await setup.verifyConnectivity();
        await setup.refreshSubscription();
        await setup.verifyStatus();
      } else if (mode === 'setup') {
        await setup.runSetup();
      } else {
        throw new Error(`Unsupported mode "${mode}". Use --mode=setup|verify|refresh`);
      }
      process.exit(0);
    } catch (err) {
      console.error('Replication script failed:', err.message);
      process.exit(1);
    } finally {
      await setup.close();
    }
  })();
}

export default ReplicationSetup;
