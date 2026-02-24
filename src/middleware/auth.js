import jwt from 'jsonwebtoken';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
};

export const ACCESS_COOKIE  = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';

export const ACCESS_MAX_AGE  = 15 * 60;            // 15 minutes (seconds)
export const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;  // 7 days (seconds)

/**
 * Return cookie options, optionally with a Max-Age for setting cookies.
 * Omitting maxAge is used for clearing (expired) cookies.
 */
export function cookieOpts(maxAge) {
  return maxAge !== undefined
    ? { ...COOKIE_OPTIONS, maxAge: maxAge * 1000 } // express maxAge is ms
    : COOKIE_OPTIONS;
}

/**
 * Authenticate request via HttpOnly cookie (preferred) or Bearer token (API clients).
 * Populates req.user on success.
 */
export function authenticateToken(req, res, next) {
  // Prefer cookie; fall back to Authorization header for API clients / curl
  const token =
    req.cookies?.[ACCESS_COOKIE] ||
    (req.headers['authorization']?.startsWith('Bearer ')
      ? req.headers['authorization'].slice(7)
      : null);

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

export function checkSubscription(requiredTier = 'basic') {
  return (req, res, next) => {
    const tierLevels = { basic: 1, premium: 2 };
    const userLevel = tierLevels[req.user.subscription_tier] || 0;
    const requiredLevel = tierLevels[requiredTier] || 0;

    if (userLevel < requiredLevel) {
      return res.status(403).json({
        error: `${requiredTier} subscription required`,
        currentTier: req.user.subscription_tier,
      });
    }
    next();
  };
}
