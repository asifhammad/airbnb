# 🔒 PRODUCTION SECURITY IMPROVEMENTS NEEDED

## Critical Issues to Fix

### 1. ❌ NO RATE LIMITING ON AUTH ENDPOINTS
**Severity**: HIGH - Brute force vulnerability

**Current**: Login/register endpoints have no rate limiting
**Risk**: Attackers can guess passwords at scale

**Fix**: Add rate limiting to auth routes
```javascript
// src/routes/auth.js (add at top)
import rateLimit from 'express-rate-limit';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                    // 5 attempts per window
  message: 'Too many login attempts, try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 3,                    // 3 registrations per hour
  message: 'Too many registrations, try again later',
  skipSuccessfulRequests: true,
});

router.post('/login', loginLimiter, async (req, res) => { ... });
router.post('/register', registerLimiter, async (req, res) => { ... });
```

---

### 2. ❌ MISSING INPUT VALIDATION
**Severity**: MEDIUM - SQL injection, XSS

**Current**: Minimal validation on user inputs
**Risk**: Malicious payloads can reach database

**Fix**: Add comprehensive input validation
```javascript
// Create validation middleware
import { body, validationResult } from 'express-validator';

// In auth routes:
router.post('/register', 
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be 8+ characters'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
  registerLimiter,
  async (req, res) => { ... }
);
```

---

### 3. ❌ NO HTTPS ENFORCEMENT
**Severity**: HIGH - Man-in-the-middle attacks

**Current**: App runs on HTTP in development and production
**Risk**: Credentials and tokens can be intercepted

**Fix**: Force HTTPS in production
```javascript
// In src/index.js (add after middleware setup)
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      res.redirect(`https://${req.header('host')}${req.url}`);
    } else {
      next();
    }
  });
}
```

---

### 4. ❌ WEAK JWT EXPIRATION
**Severity**: MEDIUM - Token theft

**Current**: JWT expires in 7 days
**Risk**: Longer window for token theft exploitation

**Fix**: Implement refresh tokens
```javascript
// Short-lived access token (15 minutes)
const accessToken = jwt.sign(payload, process.env.JWT_SECRET, { 
  expiresIn: '15m' 
});

// Long-lived refresh token (7 days)
const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { 
  expiresIn: '7d' 
});

// Store refresh token in database with user
// Send both tokens to client
// Client uses refresh token to get new access token
```

---

### 5. ❌ NO CSRF PROTECTION
**Severity**: MEDIUM - Cross-site request forgery

**Current**: No CSRF tokens
**Risk**: Attackers can trigger actions from other domains

**Fix**: Add CSRF protection
```javascript
import csrf from 'csrf';
const tokens = new csrf();

// Middleware to generate CSRF token
app.use((req, res, next) => {
  const secret = req.session?.csrfSecret || tokens.secretSync();
  if (!req.session?.csrfSecret) req.session.csrfSecret = secret;
  res.locals.csrfToken = tokens.create(secret);
  next();
});

// Validate CSRF on state-changing requests
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const token = req.body._csrf || req.headers['x-csrf-token'];
    const secret = req.session?.csrfSecret;
    
    if (!token || !tokens.verify(secret, token)) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
  }
  next();
});
```

---

### 6. ❌ NO SQLINJECTION PREVENTION ON ALL QUERIES
**Severity**: CRITICAL if missed

**Status**: ✅ Actually OK - You use parameterized queries everywhere
```javascript
// Good ✅
query('SELECT * FROM users WHERE email = $1', [email]);

// Bad ❌ (you're not doing this, but watch out for it)
query(`SELECT * FROM users WHERE email = '${email}'`);
```

---

### 7. ❌ ENVIRONMENT VARIABLES EXPOSED IN ERROR MESSAGES
**Severity**: MEDIUM - Information disclosure

**Current**: 
```javascript
// src/index.js
...(process.env.NODE_ENV === 'development' && { stack: err.stack })
```

**Fix**: Never expose stack traces in production
```javascript
app.use((err, req, res, next) => {
  logger.error('Error:', err);
  
  const isDev = process.env.NODE_ENV === 'development';
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(isDev && { stack: err.stack, details: err })
  });
});
```

---

### 8. ❌ NO PASSWORD RESET SECURITY
**Severity**: HIGH - Account takeover

**Current**: Password reset endpoints may not exist or be secure
**Risk**: Attackers can reset user passwords

**Fix**: Implement secure password reset
```javascript
// Generate secure reset token (crypto.randomBytes)
import crypto from 'crypto';

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  
  // Find user
  const user = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (user.rows.length === 0) {
    // Don't reveal if email exists (security)
    return res.json({ message: 'If email exists, reset link sent' });
  }
  
  // Generate token
  const resetToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = await bcrypt.hash(resetToken, 10);
  
  // Store in database with 1-hour expiration
  await query(
    'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL 1 HOUR)',
    [tokenHash, user.rows[0].id]
  );
  
  // Send email with reset link
  // Link: https://yourapp.com/reset?token=<resetToken>
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  
  // Find token (check expiration)
  const tokenRecord = await query(
    'SELECT user_id FROM password_reset_tokens WHERE expires_at > NOW() AND used_at IS NULL',
    []
  );
  
  // Verify token with bcrypt
  const isValid = await bcrypt.compare(token, tokenRecord.rows[0].token_hash);
  if (!isValid) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }
  
  // Update password
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, tokenRecord.rows[0].user_id]);
  
  // Mark token as used
  await query('UPDATE password_reset_tokens SET used_at = NOW() WHERE token_hash = $1', [tokenRecord.rows[0].token_hash]);
  
  res.json({ message: 'Password reset successfully' });
});
```

---

### 9. ❌ NO LOGGING/AUDIT TRAIL
**Severity**: MEDIUM - Cannot detect breaches

**Current**: Basic logging with Winston
**Risk**: Can't track who did what when

**Fix**: Add audit logging
```javascript
// Create audit logger
export async function auditLog(userId, action, resource, details = {}) {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, resource, details, ip_address, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [userId, action, resource, JSON.stringify(details), details.ip, details.userAgent]
    );
  } catch (err) {
    logger.error('Audit log error:', err);
  }
}

// Use in routes
auditLog(req.user.userId, 'CREATE_ALERT', 'search_alert', {
  alertId: result.rows[0].id,
  ip: req.ip,
  userAgent: req.get('user-agent')
});
```

**Add to schema.sql**:
```sql
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(50) NOT NULL,
  resource VARCHAR(100),
  details JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_action ON audit_logs(action);
```

---

### 10. ❌ NO DATA ENCRYPTION AT REST
**Severity**: MEDIUM - Data breach exposure

**Current**: Only passwords are encrypted
**Risk**: Database breach exposes all personal data

**Fix**: Encrypt sensitive fields
```javascript
import crypto from 'crypto';

function encryptField(value, encryptionKey) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(encryptionKey), iv);
  let encrypted = cipher.update(value, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decryptField(encrypted, encryptionKey) {
  const [iv, cipher] = encrypted.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(encryptionKey), Buffer.from(iv, 'hex'));
  let decrypted = decipher.update(cipher, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Use on sensitive fields like email verification tokens
```

---

### 11. ❌ NO API KEY/SECRET ROTATION
**Severity**: HIGH - Compromised keys stay valid

**Current**: Secrets in .env only
**Risk**: If JWT_SECRET leaks, all tokens are compromised forever

**Fix**: Implement key rotation
```javascript
// Support multiple valid JWT secrets (for rotation)
const jwtSecrets = [
  process.env.JWT_SECRET_CURRENT,
  process.env.JWT_SECRET_PREVIOUS // old key still valid for 24 hours
];

function verifyToken(token) {
  for (const secret of jwtSecrets) {
    try {
      return jwt.verify(token, secret);
    } catch (err) {
      continue;
    }
  }
  throw new Error('Invalid token');
}

// Rotate secrets weekly/monthly
```

---

### 12. ❌ NO PERMISSION CHECKING ON UPDATES
**Severity**: HIGH - Unauthorized data modification

**Example vulnerability**:
```javascript
// VULNERABLE: User can update any alert
router.put('/alerts/:id', authenticateToken, async (req, res) => {
  await query('UPDATE search_alerts SET ... WHERE id = $1', [req.params.id]);
  // Missing: check if alert belongs to user!
});

// FIXED:
router.put('/alerts/:id', authenticateToken, async (req, res) => {
  // Verify alert belongs to user
  const alert = await query(
    'SELECT user_id FROM search_alerts WHERE id = $1',
    [req.params.id]
  );
  
  if (alert.rows.length === 0 || alert.rows[0].user_id !== req.user.userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  await query('UPDATE search_alerts SET ... WHERE id = $1', [req.params.id]);
});
```

---

### 13. ❌ NO DEPENDENCY VULNERABILITY SCANNING
**Severity**: MEDIUM - Using packages with known vulnerabilities

**Fix**: Add npm audit and regular updates
```bash
# Check for vulnerabilities
npm audit

# Fix vulnerabilities
npm audit fix

# Add to CI/CD
# Fail build if vulnerabilities found
npm audit --audit-level=moderate
```

---

### 14. ❌ WORKER SERVICE UNAUTHENTICATED
**Severity**: HIGH - Anyone can trigger worker jobs

**Current**: Worker accepts jobs from Redis queue (internal only, but still risky)
**Risk**: If Redis is exposed, attacker can trigger scraping

**Fix**: Add authentication to worker queue
```javascript
// In queue.js
export async function addSearchJob(alertId, priority = 'normal', initiatedBy = null) {
  return await scrapeQueue.add(
    'search',
    { 
      alertId, 
      type: 'search',
      initiatedBy, // track who initiated
      timestamp: new Date(),
      hash: crypto.createHmac('sha256', process.env.WORKER_SECRET)
        .update(`${alertId}${Date.now()}`)
        .digest('hex')
    },
    { priority: priorityMap[priority] || 5 }
  );
}

// In worker
scrapeQueue.process('search', async (job) => {
  // Verify job wasn't tampered with
  const expectedHash = crypto.createHmac('sha256', process.env.WORKER_SECRET)
    .update(`${job.data.alertId}${job.data.timestamp}`)
    .digest('hex');
  
  if (expectedHash !== job.data.hash) {
    throw new Error('Invalid job signature');
  }
  
  // Process job
});
```

---

### 15. ❌ NO REQUEST VALIDATION SCHEMA
**Severity**: MEDIUM - Accepts invalid data

**Fix**: Add request validation schemas
```javascript
import Joi from 'joi';

const createAlertSchema = Joi.object({
  location: Joi.string().required(),
  check_in: Joi.date().required(),
  check_out: Joi.date().required(),
  price_min: Joi.number().min(0),
  price_max: Joi.number().min(0),
  guests: Joi.number().min(1).required()
});

router.post('/search', authenticateToken, async (req, res) => {
  const { error, value } = createAlertSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details });
  }
  // Use validated value
});
```

---

## 🔐 RECOMMENDED ENVIRONMENT VARIABLES

Create `.env` with these security variables:

```bash
# JWT & Authentication
JWT_SECRET=<long-random-string-min-32-chars>
JWT_REFRESH_SECRET=<different-long-random-string>
JWT_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d

# Session Security
SESSION_SECRET=<random-string>
CSRF_SECRET=<random-string>

# Email Verification
EMAIL_VERIFICATION_EXPIRY=24h

# Password Reset
PASSWORD_RESET_EXPIRY=1h
PASSWORD_MIN_LENGTH=8

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=5

# Worker Security
WORKER_SECRET=<random-string>

# Security Headers
CORS_ORIGIN=https://yourdomain.com
CORS_CREDENTIALS=true

# Encryption
ENCRYPTION_KEY=<32-char-hex-string>

# Environment
NODE_ENV=production
```

---

## 🚀 IMPLEMENTATION PRIORITY

### Phase 1 (CRITICAL - Do First):
1. Add rate limiting to auth endpoints
2. Force HTTPS in production
3. Fix permission checks on all endpoints
4. Add input validation

### Phase 2 (HIGH - Do Within Week):
1. Implement secure password reset
2. Add CSRF protection
3. Implement refresh tokens
4. Add audit logging

### Phase 3 (MEDIUM - Do Within Month):
1. Add dependency scanning
2. Implement encryption at rest
3. Add key rotation
4. Request validation schemas

---

## ✅ SECURITY CHECKLIST FOR LAUNCH

- [ ] Rate limiting on /login and /register
- [ ] HTTPS forced in production
- [ ] Permission checks on all endpoints
- [ ] Input validation on all routes
- [ ] Secure password reset implemented
- [ ] CSRF tokens on all forms
- [ ] Refresh token implementation
- [ ] Audit logging database & queries
- [ ] Environment variables documented
- [ ] npm audit passing
- [ ] No stack traces in production errors
- [ ] Redis protected (not exposed publicly)
- [ ] Database credentials secure (not in code)
- [ ] Email credentials secure (not exposed)
- [ ] Secrets rotated regularly
- [ ] HTTPS certificate valid
- [ ] Database backups enabled
- [ ] Monitoring/alerting configured
- [ ] Security headers verified (helmet)
- [ ] CORS properly configured

---

## 📞 Questions?

This is a comprehensive security audit. Implementing all recommendations will make your app production-ready for handling sensitive user data and payment information.

Which vulnerabilities would you like me to fix first?
