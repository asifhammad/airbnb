import dotenv from 'dotenv';
import crypto from 'crypto';
import pkg from 'pg';

dotenv.config();

const { Pool } = pkg;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

function maskEmail(email) {
  const v = String(email || '').toLowerCase();
  const at = v.indexOf('@');
  if (at <= 1) return '***';
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

async function supabaseAdminRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.msg || payload.error_description || payload.error || `Supabase request failed (${res.status})`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function createAuthUser(email) {
  const tempPassword = `Tmp_${crypto.randomUUID()}!aA1`;
  return supabaseAdminRequest('/auth/v1/admin/users', {
    method: 'POST',
    body: {
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { migrated_from_public_users: true },
    },
  });
}

async function main() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');
  if (!SUPABASE_SECRET_KEY) throw new Error('SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) is required');

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
    application_name: 'airbnb-alerts-auth-backfill',
  });

  const stats = {
    scanned: 0,
    alreadyLinked: 0,
    linkedByEmailMatch: 0,
    createdAndLinked: 0,
    failed: 0,
  };

  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_user_id UUID');

    const authUsersRes = await pool.query(
      `SELECT id, lower(email) AS email
       FROM auth.users
       WHERE email IS NOT NULL`
    );
    const authByEmail = new Map(authUsersRes.rows.map((r) => [r.email, r.id]));

    const { rows } = await pool.query(
      `SELECT id, email, supabase_user_id
       FROM users
       WHERE email IS NOT NULL
       ORDER BY id ASC`
    );

    console.log(`Found ${rows.length} public.users rows to evaluate`);

    for (const row of rows) {
      stats.scanned += 1;
      const userId = row.id;
      const email = String(row.email || '').trim().toLowerCase();
      const existingSupabaseId = row.supabase_user_id;

      try {
        if (!email) {
          continue;
        }

        // Fix stale/incorrect links: if linked id doesn't exist or mismatches email,
        // we will rewrite it below.
        if (existingSupabaseId) {
          const check = await pool.query(
            'SELECT id, lower(email) AS email FROM auth.users WHERE id = $1',
            [existingSupabaseId]
          );
          if (check.rows.length && check.rows[0].email === email) {
            stats.alreadyLinked += 1;
            continue;
          }
        }

        const existingAuthId = authByEmail.get(email) || null;
        if (existingAuthId) {
          await pool.query(
            'UPDATE users SET supabase_user_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [existingAuthId, userId]
          );
          stats.linkedByEmailMatch += 1;
          console.log(`Linked existing auth user -> public.users(${userId}) ${maskEmail(email)}`);
          continue;
        }

        const created = await createAuthUser(email);
        const createdId = created?.user?.id || created?.id || null;
        if (!createdId) {
          throw new Error('Created auth user but no id returned');
        }

        await pool.query(
          'UPDATE users SET supabase_user_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [createdId, userId]
        );
        authByEmail.set(email, createdId);
        stats.createdAndLinked += 1;
        console.log(`Created+linked auth user -> public.users(${userId}) ${maskEmail(email)}`);
      } catch (err) {
        stats.failed += 1;
        console.error(`Failed user ${userId} ${maskEmail(email)}: ${err.message}`);
      }
    }

    console.log('\nBackfill complete');
    console.log(JSON.stringify(stats, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
