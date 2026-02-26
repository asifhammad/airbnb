import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { body, validationResult } from 'express-validator';
import passport from 'passport';
import { query } from '../db/index.js';
import { authenticateToken, cookieOpts, ACCESS_COOKIE, REFRESH_COOKIE, ACCESS_MAX_AGE, REFRESH_MAX_AGE } from '../middleware/auth.js';
import { auditAction } from '../utils/auditLog.js';
import logger from '../utils/logger.js';

const router = express.Router();
const FRONTEND_BASE_URL = process.env.FRONTEND_URL || process.env.API_BASE_URL || 'http://localhost:3000';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function requireSupabaseConfig(res, { needsServiceRole = false } = {}) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || (needsServiceRole && !SUPABASE_SECRET_KEY)) {
    res.status(503).json({
      error: 'Supabase Auth is not configured',
      message: 'Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY'
    });
    return false;
  }
  return true;
}

async function supabaseAuthRequest(path, {
  method = 'POST',
  body,
  userAccessToken = null,
  useServiceRole = false,
} = {}) {
  const apiKey = useServiceRole ? SUPABASE_SECRET_KEY : SUPABASE_PUBLISHABLE_KEY;
  const headers = {
    apikey: apiKey,
    Authorization: userAccessToken ? `Bearer ${userAccessToken}` : `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload.error_description || payload.msg || payload.error || `Supabase auth request failed (${response.status})`);
    err.status = response.status;
    err.payload = payload;
    err.retryAfter = response.headers.get('retry-after');
    throw err;
  }
  return payload;
}

async function ensureLocalUserFromSupabase({ email, supabaseUserId, passwordHash = null }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !supabaseUserId) {
    throw new Error('ensureLocalUserFromSupabase requires email and supabaseUserId');
  }

  const existing = await query(
    `SELECT id, email, subscription_tier
     FROM users
     WHERE supabase_user_id = $1 OR email = $2
     LIMIT 1`,
    [supabaseUserId, normalizedEmail]
  );

  if (existing.rows.length) {
    const row = existing.rows[0];
    await query(
      `UPDATE users
       SET email = $1,
           supabase_user_id = $2,
           password_hash = COALESCE(password_hash, $3),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [normalizedEmail, supabaseUserId, passwordHash, row.id]
    );

    // Guardrail: keep tier aligned with active paid subscriptions only.
    const subRes = await query(
      `SELECT plan
       FROM subscriptions
       WHERE user_id = $1
         AND status IN ('active', 'trialing')
       ORDER BY updated_at DESC
       LIMIT 1`,
      [row.id]
    );
    const activePlan = subRes.rows[0]?.plan;
    const desiredTier =
      activePlan === 'premium' ? 'premium' :
      activePlan === 'basic' ? 'basic' :
      'free';

    if (row.subscription_tier !== desiredTier) {
      await query(
        `UPDATE users
         SET subscription_tier = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [desiredTier, row.id]
      );
    }
    return { id: row.id, email: normalizedEmail, subscription_tier: desiredTier };
  }

  const inserted = await query(
    `INSERT INTO users (email, password_hash, supabase_user_id, subscription_tier)
     VALUES ($1, $2, $3, 'free')
     RETURNING id, email, subscription_tier`,
    [normalizedEmail, passwordHash, supabaseUserId]
  );
  return inserted.rows[0];
}

async function findSupabaseUserIdByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
  };

  // Preferred path: direct email filter (supported on newer GoTrue versions).
  const filteredRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(normalizedEmail)}`, {
    method: 'GET',
    headers,
  });
  const filteredPayload = await filteredRes.json().catch(() => ({}));
  if (filteredRes.ok && Array.isArray(filteredPayload?.users)) {
    const exact = filteredPayload.users.find((u) => normalizeEmail(u?.email) === normalizedEmail);
    if (exact?.id) return exact.id;
  }

  // Fallback: paginate user list in case the deployment ignores the `email` query param.
  let page = 1;
  const perPage = 200;
  const maxPages = 10; // Bound requests to avoid expensive scans.
  while (page <= maxPages) {
    const pageRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      method: 'GET',
      headers,
    });
    const pagePayload = await pageRes.json().catch(() => ({}));
    if (!pageRes.ok) break;
    const users = Array.isArray(pagePayload?.users) ? pagePayload.users : [];
    const exact = users.find((u) => normalizeEmail(u?.email) === normalizedEmail);
    if (exact?.id) return exact.id;
    if (users.length < perPage) break;
    page += 1;
  }

  // Alternate payload shape fallback
  if (filteredPayload?.user && normalizeEmail(filteredPayload.user.email) === normalizedEmail) {
    return filteredPayload.user.id || null;
  }

  return null;
}

function isSupabaseInvalidCredentials(err) {
  const text = `${err?.message || ''}`.toLowerCase();
  return err?.status === 400 || text.includes('invalid login credentials') || text.includes('invalid credentials');
}

function maskEmailForLogs(email) {
  const normalized = normalizeEmail(email);
  const at = normalized.indexOf('@');
  if (at <= 1) return '***';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

// Middleware to check if Google OAuth is configured
const googleOAuthConfigured = (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    logger.warn('⚠️  Google OAuth not configured - GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set');
    return res.status(501).json({ 
      error: 'Google OAuth is not configured on this server',
      message: 'Please configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables'
    });
  }
  next();
};

// Rate limiting for login attempts (5 attempts per 15 minutes)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                    // 5 attempts per window
  message: 'Too many login attempts. Please try again later.',
  standardHeaders: true,     // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false,      // Disable `X-RateLimit-*` headers
  skip: (req, res) => process.env.NODE_ENV === 'development', // Skip in development
});

// Rate limiting for registration (3 registrations per hour)
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 3,                    // 3 registrations per window
  message: 'Too many registration attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req, res) => process.env.NODE_ENV === 'development',
});

const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many magic link requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development',
});

const changeEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many email change attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development',
});

const reauthenticateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many reauthentication attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development',
});

const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many invite attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development',
});

// Input validation rules
const registerValidationRules = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number'),
];

const loginValidationRules = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];

// Middleware to handle validation errors
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array().map(err => ({
        field: err.param,
        message: err.msg
      }))
    });
  }
  next();
};

const REFRESH_PREFIX_LEN = 16;

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshTokenPrefix(token) {
  return String(token || '').slice(0, REFRESH_PREFIX_LEN);
}

async function findValidRefreshToken(refreshToken, userId = null) {
  if (!refreshToken) return null;

  const prefix = refreshTokenPrefix(refreshToken);
  const tokenHash = hashRefreshToken(refreshToken);

  const exactParams = userId ? [tokenHash, prefix, userId] : [tokenHash, prefix];
  const exactWhere = userId ? 'AND user_id = $3' : '';
  const exactMatch = await query(
    `SELECT id, user_id, token_hash
     FROM refresh_tokens
     WHERE token_hash = $1
       AND token_prefix = $2
       AND expires_at > CURRENT_TIMESTAMP
       AND revoked_at IS NULL
       ${exactWhere}
     LIMIT 1`,
    exactParams
  );
  if (exactMatch.rows.length) return exactMatch.rows[0];

  // Backward-compatible fallback for older bcrypt-hashed rows.
  const legacyParams = userId ? [prefix, userId] : [prefix];
  const legacyWhere = userId ? 'AND user_id = $2' : '';
  const legacyCandidates = await query(
    `SELECT id, user_id, token_hash
     FROM refresh_tokens
     WHERE (token_prefix = $1 OR token_prefix = '')
       AND expires_at > CURRENT_TIMESTAMP
       AND revoked_at IS NULL
       ${legacyWhere}
     ORDER BY created_at DESC
     LIMIT 25`,
    legacyParams
  );

  for (const row of legacyCandidates.rows) {
    if (row.token_hash.startsWith('$2') && await bcrypt.compare(refreshToken, row.token_hash)) {
      return row;
    }
  }

  return null;
}

/**
 * Generate tokens for authenticated user
 * Returns short-lived access token (15 minutes) and long-lived refresh token (7 days)
 */
async function generateTokens(user) {
  // Short-lived access token
  const accessToken = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      subscription_tier: user.subscription_tier
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' } // 15 minutes
  );

  // Long-lived refresh token
  const refreshTokenSecret = crypto.randomBytes(32).toString('hex');
  const refreshTokenHash = hashRefreshToken(refreshTokenSecret);
  const tokenPrefix = refreshTokenPrefix(refreshTokenSecret);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Store refresh token in database
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, token_prefix, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [user.id, refreshTokenHash, tokenPrefix, expiresAt]
  );

  return {
    accessToken,
    refreshToken: refreshTokenSecret,
    refreshTokenExpires: expiresAt.toISOString()
  };
}


// Register new user
router.post('/register', registerLimiter, registerValidationRules, handleValidationErrors, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const { password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (!requireSupabaseConfig(res)) return;

    let supabaseSignup;
    try {
      // Triggers Dreamlit workflow: supabase.auth.signUp()
      const signupRedirectTo = `${FRONTEND_BASE_URL}/auth/callback`;
      const signupPath = `/auth/v1/signup?redirect_to=${encodeURIComponent(signupRedirectTo)}`;
      supabaseSignup = await supabaseAuthRequest(signupPath, {
        method: 'POST',
        body: {
          email,
          password,
          redirect_to: signupRedirectTo,
          options: {
            emailRedirectTo: signupRedirectTo,
          },
        },
      });
    } catch (err) {
      const msg = `${err.message || ''}`.toLowerCase();
      const code = String(err?.payload?.error_code || err?.payload?.code || '').toLowerCase();
      if (err.status === 422 || msg.includes('already')) {
        return res.status(409).json({ error: 'User already exists' });
      }
      if (err.status === 429) {
        if (code.includes('email') || msg.includes('email rate') || msg.includes('email')) {
          return res.status(429).json({
            error: 'Signup email rate limit reached in Supabase. Increase Authentication -> Rate Limits -> emails/h, or wait and retry.'
          });
        }
        // If Supabase already created the user, surface a deterministic response instead of a generic rate-limit error.
        if (SUPABASE_SECRET_KEY) {
          const existingSupabaseUserId = await findSupabaseUserIdByEmail(email);
          if (existingSupabaseUserId) {
            return res.status(409).json({ error: 'User already exists' });
          }
        }
        const retryAfterSeconds = Number.parseInt(err.retryAfter || '', 10);
        const retryAfterMinutes = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.ceil(retryAfterSeconds / 60)
          : null;
        return res.status(429).json({
          error: retryAfterMinutes
            ? `Too many signup attempts. Please wait about ${retryAfterMinutes} minute(s) and try again.`
            : 'Too many signup attempts. Please wait and try again.'
        });
      }
      logger.error('Supabase signup error:', err);
      return res.status(502).json({ error: 'Registration failed' });
    }

    let supabaseUserId =
      supabaseSignup?.user?.id ||
      supabaseSignup?.id ||
      supabaseSignup?.data?.user?.id ||
      null;

    // Some Supabase configurations may return no user object from signup.
    // Resolve by looking up the user via admin API (requires secret key).
    if (!supabaseUserId && SUPABASE_SECRET_KEY) {
      supabaseUserId = await findSupabaseUserIdByEmail(email);
    }

    if (!supabaseUserId) {
      return res.status(502).json({ error: 'Registration failed: missing Supabase user' });
    }

    const user = await ensureLocalUserFromSupabase({
      email,
      supabaseUserId,
      passwordHash: null,
    });

    // Generate access and refresh tokens
    const tokens = await generateTokens(user);

    // Log successful registration
    await auditAction(req, 'REGISTER', 'user', user.id, {
      email: user.email
    }).catch(() => {}); // Silently fail audit logging

    // If email confirmation is enabled, Supabase returns no session on sign up.
    // In that case, do not create local auth session yet.
    const hasSupabaseSession = Boolean(
      supabaseSignup?.session ||
      supabaseSignup?.access_token
    );
    if (!hasSupabaseSession) {
      return res.status(202).json({
        message: 'Please check your email and confirm your account before logging in.',
        requires_email_confirmation: true
      });
    }

    res.cookie(ACCESS_COOKIE,  tokens.accessToken,  cookieOpts(ACCESS_MAX_AGE));
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOpts(REFRESH_MAX_AGE));

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        email: user.email,
        subscription_tier: user.subscription_tier
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', loginLimiter, loginValidationRules, handleValidationErrors, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const { password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (!requireSupabaseConfig(res, { needsServiceRole: true })) return;

    const localRes = await query(
      'SELECT id, email, password_hash, subscription_tier FROM users WHERE email = $1',
      [email]
    );
    const localUser = localRes.rows[0] || null;

    let supabaseSession = null;
    try {
      supabaseSession = await supabaseAuthRequest('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: { email, password },
      });
    } catch (err) {
      // Legacy fallback: if this is an old local-only account, migrate it into Supabase.
      if (localUser?.password_hash && isSupabaseInvalidCredentials(err)) {
        const validLegacyPassword = await bcrypt.compare(password, localUser.password_hash);
        if (validLegacyPassword) {
          try {
            await supabaseAuthRequest('/auth/v1/admin/users', {
              method: 'POST',
              body: { email, password, email_confirm: true },
              useServiceRole: true,
            });
            supabaseSession = await supabaseAuthRequest('/auth/v1/token?grant_type=password', {
              method: 'POST',
              body: { email, password },
            });
          } catch (migrationErr) {
            logger.error('Legacy user migration to Supabase failed:', migrationErr);
          }
        }
      }
      if (!supabaseSession) {
        if (localUser) {
          await auditAction(req, 'LOGIN', 'user', localUser.id, {
            success: false,
            reason: 'Invalid password'
          }).catch(() => {});
        }
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    }

    const supabaseUserId = supabaseSession?.user?.id;
    if (!supabaseUserId) return res.status(401).json({ error: 'Invalid credentials' });

    const user = await ensureLocalUserFromSupabase({
      email,
      supabaseUserId,
      passwordHash: localUser?.password_hash || null,
    });

    // Generate access and refresh tokens
    const tokens = await generateTokens(user);

    // Log successful login
    await auditAction(req, 'LOGIN', 'user', user.id, {
      success: true
    }).catch(() => {});

    res.cookie(ACCESS_COOKIE,  tokens.accessToken,  cookieOpts(ACCESS_MAX_AGE));
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOpts(REFRESH_MAX_AGE));

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        subscription_tier: user.subscription_tier
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,                  // 30 refreshes per 15 minutes per IP
  message: 'Too many refresh attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/refresh', refreshLimiter, async (req, res) => {
  try {
    const refreshToken = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];
    if (!refreshToken) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const matchedToken = await findValidRefreshToken(refreshToken);
    if (!matchedToken) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Get user details
    const userResult = await query(
      'SELECT id, email, subscription_tier FROM users WHERE id = $1',
      [matchedToken.user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Rotate refresh token: revoke old token record once a new one is minted.
    await query(
      'UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1',
      [matchedToken.id]
    );

    // Generate new tokens
    const tokens = await generateTokens(user);

    res.cookie(ACCESS_COOKIE,  tokens.accessToken,  cookieOpts(ACCESS_MAX_AGE));
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOpts(REFRESH_MAX_AGE));

    res.json({
      message: 'Token refreshed successfully',
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// Logout (revoke refresh token)
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const refreshToken = req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE];

    if (refreshToken) {
      const tokenRecord = await findValidRefreshToken(refreshToken, req.user.userId);
      if (tokenRecord) {
        await query(
          'UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1',
          [tokenRecord.id]
        );
      }
    }

    // Defense in depth: end all active refresh sessions for this user.
    await query(
      `UPDATE refresh_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [req.user.userId]
    );

    // Log logout
    await auditAction(req, 'LOGOUT', 'user', req.user.userId, {
      success: true
    }).catch(() => {});

    res.clearCookie(ACCESS_COOKIE, cookieOpts());
    res.clearCookie(REFRESH_COOKIE, cookieOpts());
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

// Get current user
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, email, subscription_tier, subscription_status, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Forgot password - request reset token
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,                   // 3 requests per hour
  message: { error: 'Too many password reset requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    const payload = typeof options.message === 'object'
      ? options.message
      : { error: String(options.message || 'Too many password reset requests. Try again later.') };
    res.status(options.statusCode).json(payload);
  },
});

const forgotPasswordValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
];

router.post('/forgot-password', forgotPasswordLimiter, forgotPasswordValidation, handleValidationErrors, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    logger.info(`Forgot password requested for ${maskEmailForLogs(email)}`);
    if (!requireSupabaseConfig(res, { needsServiceRole: true })) return;

    // Explicit validation requested by product: only send reset for existing accounts.
    const localUserResult = await query(
      'SELECT id, supabase_user_id FROM users WHERE email = $1 LIMIT 1',
      [email]
    );
    const localUserId = localUserResult.rows[0]?.id || null;
    const localSupabaseUserId = localUserResult.rows[0]?.supabase_user_id || null;
    const supabaseUserId = localSupabaseUserId || await findSupabaseUserIdByEmail(email);

    // Reset email comes from Supabase Auth user records, so require auth-user existence.
    if (!supabaseUserId) {
      return res.status(404).json({ error: 'No account found for this email address' });
    }

    // Triggers Dreamlit workflow: supabase.auth.resetPasswordForEmail()
    const forgotRedirectTo = `${FRONTEND_BASE_URL}/auth/callback`;
    const recoverPath = `/auth/v1/recover?redirect_to=${encodeURIComponent(forgotRedirectTo)}`;
    try {
      await supabaseAuthRequest(recoverPath, {
        method: 'POST',
        body: {
          email,
          redirect_to: forgotRedirectTo,
        },
      });
    } catch (err) {
      logger.warn('Supabase recover request failed:', err.message);
      if (err?.status === 429) {
        return res.status(429).json({
          error: 'Password reset email rate limit reached. Please wait and try again.'
        });
      }
      return res.status(502).json({
        error: 'Failed to send password reset link. Please try again shortly.'
      });
    }

    // Best-effort audit with local user linkage if present
    if (localUserId) {
      await auditAction(req, 'REQUEST_PASSWORD_RESET', 'user', localUserId, { email }).catch(() => {});
    }

    res.json({ 
      message: 'Password reset link sent. Check your inbox.' 
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

// Reset password - use token to set new password
const resetPasswordValidation = [
  body('token')
    .notEmpty()
    .withMessage('Reset token is required'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number'),
];

const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                   // 5 attempts per hour
  message: 'Too many password reset attempts. Try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const supabaseResetPasswordValidation = [
  body('accessToken')
    .notEmpty()
    .withMessage('Recovery access token is required'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number'),
];

router.post('/reset-password', resetPasswordLimiter, resetPasswordValidation, handleValidationErrors, async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    // Find valid (unexpired, unused) reset tokens
    const tokenResult = await query(
      `SELECT token_hash, user_id FROM password_reset_tokens 
       WHERE expires_at > CURRENT_TIMESTAMP AND used_at IS NULL
       ORDER BY created_at DESC
       LIMIT 10`,
      []
    );

    if (tokenResult.rows.length === 0) {
      return res.status(400).json({ 
        error: 'Invalid or expired password reset token' 
      });
    }

    // Find matching token (constant-time comparison to prevent timing attacks)
    let matchedTokenRecord = null;
    for (const record of tokenResult.rows) {
      const isValid = await bcrypt.compare(token, record.token_hash);
      if (isValid) {
        matchedTokenRecord = record;
        break;
      }
    }

    if (!matchedTokenRecord) {
      return res.status(400).json({ 
        error: 'Invalid or expired password reset token' 
      });
    }

    const userId = matchedTokenRecord.user_id;

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);

    // Update local password (legacy fallback flow)
    await query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [passwordHash, userId]
    );

    // Keep Supabase password in sync if this account is linked.
    if (SUPABASE_URL && SUPABASE_SECRET_KEY) {
      const supabaseUserRes = await query(
        'SELECT supabase_user_id FROM users WHERE id = $1',
        [userId]
      );
      const supabaseUserId = supabaseUserRes.rows[0]?.supabase_user_id;
      if (supabaseUserId) {
        await supabaseAuthRequest(`/auth/v1/admin/users/${supabaseUserId}`, {
          method: 'PUT',
          useServiceRole: true,
          body: { password: newPassword },
        }).catch((err) => {
          logger.error('Failed syncing legacy reset password to Supabase:', err);
        });
      }
    }

    // Mark token as used
    await query(
      'UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE token_hash = $1',
      [matchedTokenRecord.token_hash]
    );

    // Log the password reset
    await auditAction(req, 'RESET_PASSWORD', 'user', userId, {
      success: true
    });

    res.json({ 
      message: 'Password reset successfully. You can now log in with your new password.' 
    });
  } catch (error) {
    console.error('Reset password error:', error);
    
    // Log failed attempt
    await auditAction(req, 'RESET_PASSWORD', 'user', null, {
      success: false,
      error: error.message
    }).catch(() => {}); // Silently fail audit logging

    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Reset password using Supabase recovery access token (from /auth#access_token=...&type=recovery)
router.post('/reset-password-supabase', resetPasswordLimiter, supabaseResetPasswordValidation, handleValidationErrors, async (req, res) => {
  try {
    const { accessToken, newPassword } = req.body;
    if (!requireSupabaseConfig(res)) return;

    const updated = await supabaseAuthRequest('/auth/v1/user', {
      method: 'PUT',
      userAccessToken: accessToken,
      body: { password: newPassword },
    });

    const email = normalizeEmail(updated?.email || updated?.user?.email);
    if (email) {
      await query(
        `UPDATE users
         SET password_hash = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE email = $1`,
        [email]
      ).catch(() => {});
    }

    res.json({
      message: 'Password reset successfully. You can now log in with your new password.'
    });
  } catch (error) {
    logger.error('Supabase reset-password error:', error);
    res.status(400).json({ error: 'Invalid or expired password reset link' });
  }
});

// Change password (authenticated users only)
const changePasswordValidation = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/)
    .withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number'),
];

const changePasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                   // 5 attempts per hour
  message: 'Too many password change attempts. Try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/change-password', authenticateToken, changePasswordLimiter, changePasswordValidation, handleValidationErrors, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.userId;
    if (!requireSupabaseConfig(res, { needsServiceRole: true })) return;

    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from your current password' });
    }

    // Resolve user and Supabase identity
    const userResult = await query(
      'SELECT email, supabase_user_id FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    if (!user.supabase_user_id) {
      return res.status(409).json({ error: 'Account is not linked to Supabase Auth yet. Please log out and log in again.' });
    }

    // Verify current password against Supabase
    try {
      await supabaseAuthRequest('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: {
          email: user.email,
          password: currentPassword,
        },
      });
    } catch (err) {
      await auditAction(req, 'CHANGE_PASSWORD', 'user', userId, {
        success: false,
        reason: 'Invalid current password'
      });
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Update in Supabase (fires auth-side update flows)
    await supabaseAuthRequest(`/auth/v1/admin/users/${user.supabase_user_id}`, {
      method: 'PUT',
      useServiceRole: true,
      body: {
        password: newPassword,
      },
    });

    // Clear local hash (Supabase is now source of truth for password)
    await query('UPDATE users SET password_hash = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [userId]);

    // Log successful password change
    await auditAction(req, 'CHANGE_PASSWORD', 'user', userId, {
      success: true
    });

    res.json({ 
      message: 'Password changed successfully' 
    });
  } catch (error) {
    console.error('Change password error:', error);
    
    // Log failed attempt
    await auditAction(req, 'CHANGE_PASSWORD', 'user', req.user.userId, {
      success: false,
      error: error.message
    }).catch(() => {});

    res.status(500).json({ error: 'Failed to change password' });
  }
});

const magicLinkValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
];

router.post('/magic-link', magicLinkLimiter, magicLinkValidation, handleValidationErrors, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!requireSupabaseConfig(res)) return;

    // Triggers Dreamlit workflow: supabase.auth.signInWithOtp()
    await supabaseAuthRequest('/auth/v1/otp', {
      method: 'POST',
      body: {
        email,
        create_user: false,
        data: {},
      },
    });

    res.json({ message: 'If this email exists, a magic link has been sent.' });
  } catch (error) {
    if (error?.status === 429) {
      return res.status(429).json({
        error: 'Please wait before requesting another magic link.',
      });
    }
    if (error?.status === 422) {
      return res.status(400).json({
        error: 'Magic link login is not enabled in Supabase Auth settings.',
      });
    }
    logger.error('Magic link error:', error);
    res.status(500).json({ error: 'Failed to send magic link' });
  }
});

const changeEmailValidation = [
  body('newEmail')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
];

router.post('/change-email', authenticateToken, changeEmailLimiter, changeEmailValidation, handleValidationErrors, async (req, res) => {
  try {
    const newEmail = normalizeEmail(req.body?.newEmail);
    const userId = req.user.userId;
    if (!requireSupabaseConfig(res, { needsServiceRole: true })) return;

    const userResult = await query(
      'SELECT id, email, supabase_user_id FROM users WHERE id = $1',
      [userId]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });

    const user = userResult.rows[0];
    if (!user.supabase_user_id) {
      return res.status(409).json({ error: 'Account is not linked to Supabase Auth yet. Please log out and log in again.' });
    }

    // Triggers Dreamlit workflow: supabase.auth.updateUser({ email })
    await supabaseAuthRequest(`/auth/v1/admin/users/${user.supabase_user_id}`, {
      method: 'PUT',
      useServiceRole: true,
      body: { email: newEmail },
    });

    await query(
      'UPDATE users SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newEmail, userId]
    );

    await auditAction(req, 'CHANGE_EMAIL', 'user', userId, {
      oldEmail: user.email,
      newEmail,
      success: true,
    }).catch(() => {});

    res.json({ message: 'Email updated successfully' });
  } catch (error) {
    logger.error('Change email error:', error);
    res.status(500).json({ error: 'Failed to change email' });
  }
});

const reauthenticateValidation = [
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];

router.post('/reauthenticate', authenticateToken, reauthenticateLimiter, reauthenticateValidation, handleValidationErrors, async (req, res) => {
  try {
    const { password } = req.body;
    const userId = req.user.userId;
    if (!requireSupabaseConfig(res)) return;

    const userResult = await query(
      'SELECT email FROM users WHERE id = $1',
      [userId]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    const email = userResult.rows[0].email;

    // Reauth equivalent: force password check against Supabase.
    // This is the backend-safe version of supabase.auth.reauthenticate().
    await supabaseAuthRequest('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email, password },
    });

    res.json({ message: 'Reauthentication successful' });
  } catch (error) {
    logger.error('Reauthentication error:', error);
    res.status(401).json({ error: 'Reauthentication failed' });
  }
});

const inviteValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
];

router.post('/invite', inviteLimiter, inviteValidation, handleValidationErrors, async (req, res) => {
  try {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.headers['x-admin-secret'] !== adminSecret) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!requireSupabaseConfig(res, { needsServiceRole: true })) return;
    const email = normalizeEmail(req.body?.email);

    // Triggers Dreamlit workflow: supabase.auth.admin.inviteUserByEmail()
    await supabaseAuthRequest('/auth/v1/invite', {
      method: 'POST',
      useServiceRole: true,
      body: {
        email,
        data: {},
      },
    });

    res.json({ message: 'Invite sent successfully' });
  } catch (error) {
    logger.error('Invite user error:', error);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GOOGLE OAUTH 2.0 ROUTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initiate Google OAuth 2.0 login flow
 * Redirects user to Google consent screen
 * Passport automatically handles state parameter for CSRF protection
 */
router.get('/google',
  googleOAuthConfigured,
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    accessType: 'offline',
    prompt: 'consent',
  })
);

/**
 * Google OAuth 2.0 callback
 * Exchange authorization code for tokens and create/update user
 * Security: Passport handles state parameter validation automatically
 */
router.get('/google/callback',
  googleOAuthConfigured,
  passport.authenticate('google', {
    failureRedirect: '/auth?error=google_auth_failed',
    session: true,
  }),
  async (req, res) => {
    try {
      const user = req.user;

      // Generate access and refresh tokens for client
      const accessToken = jwt.sign(
        {
          userId: user.id,
          email: user.email,
          subscription_tier: user.subscription_tier
        },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      // Generate refresh token
      const refreshTokenSecret = crypto.randomBytes(32).toString('hex');
      const refreshTokenHash = hashRefreshToken(refreshTokenSecret);
      const tokenPrefix = refreshTokenPrefix(refreshTokenSecret);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await query(
        `INSERT INTO refresh_tokens (user_id, token_hash, token_prefix, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [user.id, refreshTokenHash, tokenPrefix, expiresAt]
      );

      // Log successful Google OAuth login
      await auditAction(req, 'LOGIN_GOOGLE', 'user', user.id, {
        success: true,
        method: 'google_oauth'
      }).catch(() => {});

      // Set tokens as HttpOnly cookies instead of URL parameters.
      // URL parameters leak into server logs, browser history, and Referer headers.
      res.cookie(ACCESS_COOKIE,  accessToken,        cookieOpts(ACCESS_MAX_AGE));
      res.cookie(REFRESH_COOKIE, refreshTokenSecret, cookieOpts(REFRESH_MAX_AGE));

      // Redirect cleanly — no tokens in the URL
      const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/`;
      res.redirect(redirectUrl);
    } catch (error) {
      console.error('Google OAuth callback error:', error);
      res.redirect('/auth?error=callback_failed');
    }
  }
);

/**
 * Logout via Google OAuth
 * Revokes session and clears Passport session
 */
router.post('/google/logout', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Log logout
    await auditAction(req, 'LOGOUT_GOOGLE', 'user', userId, {
      success: true,
      method: 'google_oauth'
    }).catch(() => {});

    // Clear Passport session
      req.logout((err) => {
        if (err) {
          console.error('Logout error:', err);
          return res.status(500).json({ error: 'Failed to logout' });
        }

        res.clearCookie(ACCESS_COOKIE, cookieOpts());
        res.clearCookie(REFRESH_COOKIE, cookieOpts());
        res.json({ message: 'Logged out successfully' });
      });
  } catch (error) {
    console.error('Google logout error:', error);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

export default router;
