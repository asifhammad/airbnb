import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import ConnectPgSimple from 'connect-pg-simple';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
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
const isDev = process.env.NODE_ENV === 'development';

if (process.env.NODE_ENV === 'production' && !sessionSecret) {
  throw new Error('SESSION_SECRET must be set in production');
}

function resolveTrustProxy() {
  // Explicit override wins: TRUST_PROXY=false|true|1|2...
  if (process.env.TRUST_PROXY !== undefined) {
    const raw = String(process.env.TRUST_PROXY).trim().toLowerCase();
    if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
    if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return 1;
    const asNum = Number.parseInt(raw, 10);
    return Number.isFinite(asNum) ? asNum : 1;
  }

  // Railway/reverse proxy setups send X-Forwarded-* headers.
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_STATIC_URL) return 1;

  // Default to off for local/non-proxy environments.
  return false;
}

const trustProxy = resolveTrustProxy();
if (trustProxy !== false) app.set('trust proxy', trustProxy);

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
  'adminpanel',
  'fullz',
  'carding',
  'send_acc',
  'stored.php',
];

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
  if (blockedExtensions.has(ext)) return true;
  return blockedPathTokens.some((token) => pathLower.includes(token));
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
    // Check if connection is already HTTPS or if it's being proxied through HTTPS
    // x-forwarded-proto is set by Railway/reverse proxies
    if (req.header('x-forwarded-proto') !== 'https' && !req.secure) {
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

// Serve static files
app.use(express.static('public'));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV 
  });
});

// Public client-side config (safe values only)
app.get('/api/public-config', (req, res) => {
  res.json({
    posthog: {
      enabled: Boolean(process.env.POSTHOG_PUBLIC_KEY),
      key: process.env.POSTHOG_PUBLIC_KEY || null,
      host: POSTHOG_HOST,
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
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
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
