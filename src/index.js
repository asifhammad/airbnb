import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import ConnectPgSimple from 'connect-pg-simple';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
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

// ── Stripe webhook MUST be registered before express.json() consumes the body ──
// Stripe signature verification requires the raw Buffer, not a parsed object.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', '*.airbnb.com', 'a0.muscache.com'],
      connectSrc:  ["'self'"],
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
