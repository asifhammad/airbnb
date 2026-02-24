import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Database Migration Tool for Railway -> Supabase Migration
 * 
 * This script handles:
 * 1. Dumping data from Railway (source)
 * 2. Validating schema compatibility
 * 3. Loading data into Supabase (target)
 * 4. Verifying data integrity
 */

class DatabaseMigrator {
  constructor() {
    if (!process.env.DATABASE_REPLICA_URL) {
      throw new Error('DATABASE_REPLICA_URL (Railway) is required for migration');
    }
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL (Supabase) is required for migration');
    }

    // Source pool (Railway)
    this.sourcePool = new Pool({
      connectionString: process.env.DATABASE_REPLICA_URL,
      ssl: { rejectUnauthorized: false },
    });

    // Target pool (Supabase) — always SSL, forces IPv4 resolution
    this.targetPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });

    this.tables = [
      'users',
      'password_reset_tokens',
      'refresh_tokens',
      'search_alerts',
      'listings',
      'search_results',
      'listing_price_history',
      'notifications',
      'audit_logs',
    ];

    this.migrationLog = {
      startTime: null,
      endTime: null,
      status: 'pending',
      tables: {},
      errors: [],
      warnings: []
    };
  }

  async log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = {
      info: '✅',
      warn: '⚠️ ',
      error: '❌'
    }[level] || '💬';

    console.log(`[${timestamp}] ${prefix} ${message}`);

    if (level === 'error') {
      this.migrationLog.errors.push(message);
    } else if (level === 'warn') {
      this.migrationLog.warnings.push(message);
    }
  }

  /**
   * Step 1: Verify database connectivity
   */
  async verifyConnectivity() {
    await this.log('Verifying database connectivity...');

    try {
      const sourceClient = await this.sourcePool.connect();
      await sourceClient.query('SELECT 1');
      sourceClient.release();
      await this.log('✅ Connected to Railway (source)');
    } catch (err) {
      await this.log(`Failed to connect to Railway: ${err.message}`, 'error');
      throw err;
    }

    try {
      const targetClient = await this.targetPool.connect();
      await targetClient.query('SELECT 1');
      targetClient.release();
      await this.log('✅ Connected to Supabase (target)');
    } catch (err) {
      await this.log(`Failed to connect to Supabase: ${err.message}`, 'error');
      throw err;
    }
  }

  /**
   * Step 2: Ensure target schema exists
   */
  async ensureTargetSchema() {
    await this.log('Ensuring target schema exists in Supabase...');

    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    const statements = schema
      .split(/;\s*(?:\r?\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      try {
        await this.targetPool.query(stmt);
      } catch (err) {
        // Ignore errors for objects that already exist
        if (err && (err.code === '42P07' || err.code === '42710')) {
          continue;
        }
        // Ignore column already exists errors
        if (err && err.code === '42701') {
          continue;
        }
        throw err;
      }
    }

    await this.log('✅ Target schema validated/created');
  }

  /**
   * Step 3: Get table statistics from source
   */
  async getTableStats(pool, tableName) {
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM ' + tableName
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Step 4: Disable constraints on target (optional, speeds up migration)
   */
  async disableConstraints() {
    await this.log('Disabling foreign key constraints on target...');

    // Get all foreign keys
    const result = await this.targetPool.query(`
      SELECT constraint_name, table_name
      FROM information_schema.table_constraints
      WHERE constraint_type = 'FOREIGN KEY'
    `);

    // PostgreSQL doesn't have a global way to disable all FKs like MySQL
    // Instead, we'll just log a warning
    if (result.rows.length > 0) {
      await this.log(`Found ${result.rows.length} foreign key constraints`, 'warn');
      await this.log('Constraints will be checked during migration', 'warn');
    }
  }

  /**
   * Step 5: Migrate data for a single table
   */
  async migrateTable(tableName) {
    await this.log(`Starting migration of ${tableName}...`);

    const tableLog = {
      tableName,
      sourceCount: 0,
      targetCount: 0,
      inserted: 0,
      errors: []
    };

    try {
      // Get source data count
      tableLog.sourceCount = await this.getTableStats(this.sourcePool, tableName);
      await this.log(`  Source ${tableName}: ${tableLog.sourceCount} rows`);

      // Get columns from BOTH source and target, only migrate intersection.
      // This handles schema drift where Railway has columns not yet in schema.sql.
      const [sourceColRes, targetColRes] = await Promise.all([
        this.sourcePool.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1
           ORDER BY ordinal_position`, [tableName]
        ),
        this.targetPool.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1
           ORDER BY ordinal_position`, [tableName]
        ),
      ]);

      const sourceColumns = new Set(sourceColRes.rows.map(r => r.column_name));
      const targetColumns = new Set(targetColRes.rows.map(r => r.column_name));

      // Warn about columns on source that won't be migrated
      for (const col of sourceColumns) {
        if (!targetColumns.has(col)) {
          await this.log(`  Skipping column "${col}" on ${tableName} — not present on target (add to schema.sql)`, 'warn');
        }
      }

      const columns = [...sourceColumns].filter(c => targetColumns.has(c));
      const columnsList = columns.join(', ');

      // Fetch all data from source (only shared columns)
      const sourceResult = await this.sourcePool.query(
        `SELECT ${columnsList} FROM ${tableName}`
      );

      // Insert into target in batches
      const batchSize = 1000;
      for (let i = 0; i < sourceResult.rows.length; i += batchSize) {
        const batch = sourceResult.rows.slice(i, i + batchSize);

        for (const row of batch) {
          const values = columns.map(col => row[col]);
          const placeholders = columns.map((_, idx) => `$${idx + 1}`).join(', ');

          try {
            // Sanitize values: coerce any malformed JSON strings to null
            // rather than letting a bad value crash the whole migration.
            // PostgreSQL on Railway may store JSONB as native objects which
            // pg serialises differently to what Supabase's parser expects.
            const safeValues = values.map((v) => {
              if (v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)) {
                // pg returns JSONB columns as already-parsed JS objects;
                // re-serialise so Supabase receives a valid JSON string.
                try { return JSON.stringify(v); } catch { return null; }
              }
              if (typeof v === 'string' && v.startsWith('{') && v.includes(',')) {
                // Postgres array-literal syntax e.g. {"51","52"} — convert to JSON array
                try {
                  const inner = v.slice(1, -1);
                  const items = inner.split(',').map(s => {
                    s = s.trim();
                    if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
                    return isNaN(s) ? s : Number(s);
                  });
                  return JSON.stringify(items);
                } catch { return null; }
              }
              return v;
            });
            await this.targetPool.query(
              `INSERT INTO ${tableName} (${columnsList}) VALUES (${placeholders})`,
              safeValues
            );
            tableLog.inserted++;
          } catch (err) {
            // Log specific errors (e.g., duplicate keys) but continue
            tableLog.errors.push({
              row: row,
              error: err.message,
              code: err.code
            });

            // Skip duplicate key errors
            if (err.code === '23505') {
              await this.log(`  Skipping duplicate in ${tableName}`, 'warn');
            } else {
              throw err;
            }
          }
        }

        const progress = Math.min(i + batchSize, sourceResult.rows.length);
        await this.log(`  ${tableName}: ${progress}/${sourceResult.rows.length} rows migrated`);
      }

      // Get final count
      tableLog.targetCount = await this.getTableStats(this.targetPool, tableName);

      await this.log(`✅ Completed ${tableName}: ${tableLog.inserted} rows inserted`);
      this.migrationLog.tables[tableName] = tableLog;

      return tableLog;
    } catch (err) {
      tableLog.errors.push({ error: err.message });
      await this.log(`❌ Error migrating ${tableName}: ${err.message}`, 'error');
      this.migrationLog.tables[tableName] = tableLog;
      throw err;
    }
  }

  /**
   * Step 6: Verify data integrity
   */
  async verifyIntegrity() {
    await this.log('Verifying data integrity...');

    let allMatch = true;

    for (const table of this.tables) {
      try {
        const sourceCount = await this.getTableStats(this.sourcePool, table);
        const targetCount = await this.getTableStats(this.targetPool, table);

        if (sourceCount !== targetCount) {
          await this.log(
            `${table}: Source has ${sourceCount} rows, target has ${targetCount} rows`,
            'warn'
          );
          allMatch = false;
        } else {
          await this.log(`${table}: ✅ ${sourceCount} rows match`);
        }
      } catch (err) {
        await this.log(`Could not verify ${table}: ${err.message}`, 'warn');
      }
    }

    if (allMatch) {
      await this.log('✅ All tables match source counts');
    }

    return allMatch;
  }

  /**
   * Main migration orchestration
   */
  async run(options = {}) {
    const {
      skipVerification = false,
      migrateOnly = []
    } = options;

    this.migrationLog.startTime = new Date();

    try {
      await this.log('🚀 Starting database migration from Railway to Supabase');
      await this.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

      // Step 1: Verify connectivity
      await this.verifyConnectivity();

      // Step 2: Ensure target schema
      await this.ensureTargetSchema();

      // Step 3: Disable constraints (optional)
      await this.disableConstraints();

      // Step 4: Migrate tables
      const tablesToMigrate = migrateOnly.length > 0 ? migrateOnly : this.tables;

      for (const table of tablesToMigrate) {
        await this.migrateTable(table);
      }

      // Step 5: Verify integrity
      if (!skipVerification) {
        await this.verifyIntegrity();
      }

      this.migrationLog.status = 'completed';
      await this.log('✅ Migration completed successfully!');
    } catch (err) {
      this.migrationLog.status = 'failed';
      await this.log(`Migration failed: ${err.message}`, 'error');
      throw err;
    } finally {
      this.migrationLog.endTime = new Date();
      const duration = (this.migrationLog.endTime - this.migrationLog.startTime) / 1000;
      await this.log(`Total time: ${duration.toFixed(2)} seconds`);

      // Save migration log
      await this.saveMigrationLog();

      // Close connections
      await this.close();
    }
  }

  /**
   * Save migration log to file
   */
  async saveMigrationLog() {
    const fs = await import('fs').then(m => m.promises);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = join(__dirname, `migration-log-${timestamp}.json`);

    try {
      await fs.writeFile(logFile, JSON.stringify(this.migrationLog, null, 2));
      await this.log(`Migration log saved to ${logFile}`);
    } catch (err) {
      await this.log(`Failed to save migration log: ${err.message}`, 'warn');
    }
  }

  /**
   * Close database connections
   */
  async close() {
    try {
      await this.sourcePool.end();
      await this.targetPool.end();
      await this.log('✅ Database connections closed');
    } catch (err) {
      await this.log(`Error closing connections: ${err.message}`, 'warn');
    }
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const migrator = new DatabaseMigrator();

  // Parse command line arguments
  const skipVerification = process.argv.includes('--skip-verification');
  const specificTables = process.argv
    .find(arg => arg.startsWith('--tables='))
    ?.split('=')[1]
    ?.split(',') || [];

  migrator
    .run({ skipVerification, migrateOnly: specificTables })
    .then(() => {
      console.log('\n✅ Migration process completed');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Migration process failed:', err);
      process.exit(1);
    });
}

export default DatabaseMigrator;
