import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import ConnectPgSimple from 'connect-pg-simple';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import logger from './utils/logger.js';
import { auditContext } from './utils/auditLog.js';
import { configurePassport } from './middleware/passport.js';
import passport from 'passport';
import { startScheduler } from './scheduler/index.js';
import { waitForDb } from './db/index.js';
import pool from './db/index.js';

// Routes
import authRoutes from './routes/auth.js';
import alertRoutes from './routes/alerts.js';
import listingRoutes from './routes/listings.js';
import billingRoutes, { stripeWebhookHandler } from './routes/billing.js';
import adminRoutes from './routes/admin.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const sessionSecret = process.env.SESSION_SECRET;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const API_BASE_URL = process.env.API_BASE_URL || `http://localhost:${PORT}`;
const isDev = process.env.NODE_ENV === 'development';

function sanitizePublicHttpUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

if (process.env.NODE_ENV === 'production' && !sessionSecret) {
  throw new Error('SESSION_SECRET must be set in production');
}

function resolveTrustProxy() {
  // Explicit override wins: TRUST_PROXY=false|true|1|2...
  if (process.env.TRUST_PROXY !== undefined) {
    const raw = String(process.env.TRUST_PROXY).trim().toLowerCase();
    if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
    if (raw === 'true' || raw === 'on' || raw === 'yes') return 1;
    const asNum = Number.parseInt(raw, 10);
    if (Number.isFinite(asNum) && asNum >= 1) return asNum;
    return false;
  }

  // In production, require explicit TRUST_PROXY to avoid accidental spoofable configs.
  if (process.env.NODE_ENV === 'production') return false;

  // Default to off for local/non-proxy environments.
  return false;
}

const trustProxy = resolveTrustProxy();
if (trustProxy !== false) app.set('trust proxy', trustProxy);
if (process.env.NODE_ENV === 'production' && trustProxy === false) {
  logger.warn('TRUST_PROXY is disabled in production. Set TRUST_PROXY=1 (or specific hop count) when behind a trusted reverse proxy.');
}

function buildCspHosts() {
  const hosts = new Set(['https://us.i.posthog.com', 'https://eu.i.posthog.com']);
  try {
    if (POSTHOG_HOST) {
      const u = new URL(POSTHOG_HOST);
      hosts.add(`${u.protocol}//${u.host}`);
    }
  } catch (_) {
    // ignore invalid POSTHOG_HOST; defaults above still apply
  }
  return Array.from(hosts);
}
const cspHosts = buildCspHosts();

// ── Stripe webhook MUST be registered before express.json() consumes the body ──
// Stripe signature verification requires the raw Buffer, not a parsed object.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

app.disable('x-powered-by');

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
  message: { error: 'Too many requests. Please try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isDev,
  message: { error: 'API rate limit exceeded. Please try again later.' },
});

const blockedExtensions = new Set([
  '.php', '.asp', '.aspx', '.jsp', '.cgi', '.pl', '.env', '.sql', '.ini', '.bak', '.old',
  '.swp', '.log', '.cfg', '.conf', '.yml', '.yaml', '.pem', '.key',
]);

const blockedPathTokens = [
  'wp-config',
  'wp-json',
  'adminpanel',
  'fullz',
  'carding',
  'send_acc',
  'stored.php',
];

const blockedPathPrefixes = [
  '/wordpress',
  '/wp-',
  '/wp/',
  '/wp-admin',
  '/wp-content',
  '/wp-includes',
  '/cgi-bin',
  '/.git',
  '/.svn',
  '/.hg',
  '/.vscode',
  '/laravel',
  '/phpmyadmin',
  '/actuator',
  '/_profiler',
  '/_wdt',
  '/__debug__',
  '/__webpack_dev_server__',
  '/webpack-dev-server',
  '/horizon/api',
  '/telescope',
  '/server-status',
  '/server-info',
];

const blockedExactPaths = new Set([
  '/env',
  '/info.php',
  '/phpinfo.php',
  '/php_info.php',
  '/test.php',
  '/i.php',
  '/asset-manifest.json',
]);

const knownClientRoutes = new Set([
  '/',
  '/auth',
  '/auth/callback',
  '/settings',
  '/billing',
  '/admin',
]);

const denylistIps = new Set(
  String(process.env.SECURITY_DENYLIST_IPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const denylistUaSubstrings = String(process.env.SECURITY_DENYLIST_UA || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const probeBanThreshold = Number.parseInt(process.env.PROBE_BAN_THRESHOLD || '8', 10);
const probeBanWindowMs = Number.parseInt(process.env.PROBE_BAN_WINDOW_MS || String(10 * 60 * 1000), 10);
const probeBanDurationMs = Number.parseInt(process.env.PROBE_BAN_DURATION_MS || String(60 * 60 * 1000), 10);
const probeTracker = new Map();

function normalizeIp(rawIp) {
  const ip = String(rawIp || '').trim();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isDeniedByIpOrUa(req) {
  const ip = normalizeIp(req.ip);
  if (denylistIps.has(ip)) return true;

  const ua = String(req.get('user-agent') || '').toLowerCase();
  return denylistUaSubstrings.some((needle) => ua.includes(needle));
}

function isTempBanned(ip) {
  const entry = probeTracker.get(ip);
  if (!entry) return false;
  if (!entry.bannedUntil || entry.bannedUntil <= Date.now()) return false;
  return true;
}

function noteProbeAndMaybeBan(ip) {
  const now = Date.now();
  const entry = probeTracker.get(ip) || { count: 0, firstSeen: now, bannedUntil: 0 };

  if (entry.bannedUntil > now) {
    probeTracker.set(ip, entry);
    return { banned: true, newlyBanned: false };
  }

  if (now - entry.firstSeen > probeBanWindowMs) {
    entry.count = 0;
    entry.firstSeen = now;
  }

  entry.count += 1;
  let newlyBanned = false;
  if (entry.count >= probeBanThreshold) {
    entry.bannedUntil = now + probeBanDurationMs;
    entry.count = 0;
    entry.firstSeen = now;
    newlyBanned = true;
  }

  probeTracker.set(ip, entry);
  return { banned: entry.bannedUntil > now, newlyBanned };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of probeTracker.entries()) {
    const banExpired = !entry.bannedUntil || entry.bannedUntil <= now;
    const windowExpired = now - entry.firstSeen > probeBanWindowMs;
    if (banExpired && windowExpired) {
      probeTracker.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref();

function isSuspiciousProbe(req) {
  if (!(req.method === 'GET' || req.method === 'HEAD')) return false;
  if (req.path.startsWith('/api/')) return false;

  const rawPath = String(req.path || '');
  const pathLower = rawPath.toLowerCase();
  const ext = path.extname(pathLower);

  if (pathLower.includes('..') || pathLower.includes('%2e%2e') || pathLower.includes('%00')) return true;
  if (blockedExactPaths.has(pathLower)) return true;
  if (blockedPathPrefixes.some((prefix) => pathLower.startsWith(prefix))) return true;
  if (blockedExtensions.has(ext)) return true;
  return blockedPathTokens.some((token) => pathLower.includes(token));
}

function normalizedRoutePath(value) {
  const p = String(value || '');
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}

function isLikelyScannerPath(value) {
  const lower = String(value || '').toLowerCase();
  const ext = path.extname(lower);
  if (blockedExtensions.has(ext)) return true;
  if (blockedExactPaths.has(lower)) return true;
  if (blockedPathPrefixes.some((prefix) => lower.startsWith(prefix))) return true;
  return blockedPathTokens.some((token) => lower.includes(token));
}

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", ...cspHosts],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', '*.airbnb.com', 'a0.muscache.com', ...cspHosts],
      connectSrc:  ["'self'", ...cspHosts],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
    },
  },
}));

// Allow email auth callback page to render in embedded email/webview containers.
// Keep frame protection for all other routes.
app.use((req, res, next) => {
  const normalizedPath =
    req.path.length > 1 && req.path.endsWith('/')
      ? req.path.slice(0, -1)
      : req.path;
  if (normalizedPath === '/auth/callback' || normalizedPath === '/auth/callback.html') {
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Content-Security-Policy-Report-Only');
  }
  next();
});

// Serve auth callback explicitly so we can guarantee iframe-compatible headers
// even when route rewriting/static middleware order changes.
app.get(['/auth/callback', '/auth/callback/'], (req, res) => {
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('Content-Security-Policy-Report-Only');
  // Embedded email/webview flows can be sandboxed; COOP same-origin blocks these.
  // Keep this relaxed only on the dedicated auth callback endpoint.
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(process.cwd(), 'public', 'auth.html'));
});

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));

app.use(globalLimiter);
app.use('/api', apiLimiter);

app.use((req, res, next) => {
  const ip = normalizeIp(req.ip);

  if (isDeniedByIpOrUa(req)) {
    logger.warn(`Blocked denylisted client: ${req.method} ${req.path} ip=${ip}`);
    return res.status(403).send('Forbidden');
  }

  if (isTempBanned(ip)) {
    logger.warn(`Blocked temp-banned client: ${req.method} ${req.path} ip=${ip}`);
    return res.status(403).send('Forbidden');
  }

  if (!isSuspiciousProbe(req)) return next();

  const banState = noteProbeAndMaybeBan(ip);
  if (banState.newlyBanned) {
    logger.warn(`Temporarily banned IP for repeated probes: ip=${ip}`);
  }
  logger.warn(`Blocked suspicious probe: ${req.method} ${req.path} ip=${ip}`);
  return res.status(404).send('Not found');
});

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));
app.use(cookieParser());

const trustedOrigins = new Set([FRONTEND_URL, API_BASE_URL]);
const csrfSafeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeOrigin(value) {
  try {
    const u = new URL(String(value || '').trim());
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return null;
  }
}

function originHost(value) {
  try {
    return new URL(String(value || '').trim()).host.toLowerCase();
  } catch (_) {
    return null;
  }
}

function ensureCsrfCookie(req, res) {
  if (req.cookies?.csrf_token) return req.cookies.csrf_token;
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie('csrf_token', token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  });
  return token;
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();

  // Ensure browser clients have a CSRF token cookie available.
  if (csrfSafeMethods.has(req.method)) {
    ensureCsrfCookie(req, res);
    return next();
  }

  // Non-browser/API clients using bearer tokens are not CSRF-vulnerable.
  const hasBearer = req.headers.authorization?.startsWith('Bearer ');
  if (hasBearer) return next();

  const origin = normalizeOrigin(req.headers.origin);
  const referer = normalizeOrigin(req.headers.referer);
  const requestHost = String(req.headers.host || '').toLowerCase();
  const originHostValue = originHost(req.headers.origin);
  const refererHostValue = originHost(req.headers.referer);

  if (
    (origin && trustedOrigins.has(origin)) ||
    (referer && trustedOrigins.has(referer)) ||
    (originHostValue && requestHost && originHostValue === requestHost) ||
    (refererHostValue && requestHost && refererHostValue === requestHost)
  ) {
    return next();
  }

  const cookieToken = req.cookies?.csrf_token;
  const headerToken = req.headers['x-csrf-token'];
  if (cookieToken && headerToken && cookieToken === headerToken) {
    return next();
  }

  return res.status(403).json({ error: 'CSRF validation failed' });
});

// Attach audit context to all requests
app.use(auditContext());

// Session configuration (required for Passport.js)
const PgSession = ConnectPgSimple(session);
app.use(
  session({
    store: new PgSession({
      pool: pool,
      tableName: 'session',
      createTableIfMissing: true,
      errorLog: (err) => logger.error('Session store error:', err),
    }),
    secret: sessionSecret || 'dev-only-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // HTTPS only in production
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'lax', // CSRF protection
    },
  })
);

// Configure and initialize Passport.js
configurePassport();
app.use(passport.initialize());
app.use(passport.session());

// Enforce HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    // req.secure respects Express trust proxy settings; avoid trusting raw headers directly.
    if (!req.secure) {
      return res.redirect(301, `https://${req.header('host')}${req.url}`);
    }
    next();
  });
}

// URL rewriting middleware: map clean URLs to .html files
app.use((req, res, next) => {
  const cleanToHtml = {
    '/auth': '/auth.html',
    '/settings': '/settings.html',
    '/billing': '/billing.html',
    '/admin': '/admin.html',
  };

  // Normalize trailing slash so /auth/ resolves like /auth.
  const normalizedPath =
    req.path.length > 1 && req.path.endsWith('/')
      ? req.path.slice(0, -1)
      : req.path;

  // If the request path matches a clean URL, rewrite to .html (preserve query string).
  if (cleanToHtml[normalizedPath]) {
    const qIndex = req.url.indexOf('?');
    const query = qIndex >= 0 ? req.url.slice(qIndex) : '';
    req.url = `${cleanToHtml[normalizedPath]}${query}`;
  }
  
  next();
});

// Reject unknown non-API "page" routes instead of falling through to SPA-like behavior.
app.use((req, res, next) => {
  if (!(req.method === 'GET' || req.method === 'HEAD')) return next();
  if (req.path.startsWith('/api/')) return next();

  const normalized = normalizedRoutePath(req.path);
  const ext = path.extname(normalized);
  if (ext) return next(); // let static handler try file assets

  if (knownClientRoutes.has(normalized)) return next();
  return res.status(404).send('Not found');
});

// Serve static files
app.use(express.static('public'));

// Request logging
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const status = res.statusCode;
    const isApi = req.path.startsWith('/api/');
    const normalized = normalizedRoutePath(req.path);

    if (isApi || status >= 500 || knownClientRoutes.has(normalized)) {
      logger.info(`${req.method} ${req.path} ${status} ${ms}ms`);
      return;
    }

    if (status >= 400 && isLikelyScannerPath(req.path)) {
      logger.debug(`${req.method} ${req.path} ${status} ${ms}ms`);
    }
  });
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
  });
});

// Public client-side config (safe values only)
app.get('/api/public-config', (req, res) => {
  const referlyAffiliateUrl = sanitizePublicHttpUrl(process.env.REFERLY_AFFILIATE_URL);
  res.json({
    posthog: {
      enabled: Boolean(process.env.POSTHOG_PUBLIC_KEY),
      key: process.env.POSTHOG_PUBLIC_KEY || null,
      host: POSTHOG_HOST,
    },
    referly: {
      enabled: Boolean(referlyAffiliateUrl),
      affiliate_url: referlyAffiliateUrl,
    },
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/admin', adminRoutes);

// 404 handler
app.use((req, res) => {
  if (!req.path.startsWith('/api/')) {
    return res.status(404).send('Not found');
  }
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Error:', err);
  const isProduction = process.env.NODE_ENV === 'production';
  res.status(err.status || 500).json({
    error: isProduction ? 'Internal server error' : (err.message || 'Internal server error'),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// Initialize database and start server
async function start() {
  try {
    // Wait for Postgres to be reachable (handles Railway cold-start race condition)
    await waitForDb();

    // Start scheduler
    startScheduler();
    
    // Start server
    app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`🔗 API: http://localhost:${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

export default app;
