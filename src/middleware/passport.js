import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { query } from '../db/index.js';
import logger from '../utils/logger.js';

/**
 * Configure Passport.js with Google OAuth 2.0
 * Only configures if GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are provided
 * Uses parameterized queries to prevent SQL injection
 * Implements secure user creation/update flow
 */
export function configurePassport() {
  // Always configure serialization/deserialization (needed for session management)
  // Serialize user for session
  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  // Deserialize user from session
  passport.deserializeUser(async (id, done) => {
    try {
      const result = await query(
        'SELECT id, email, display_name, avatar_url, subscription_tier FROM users WHERE id = $1',
        [id]
      );
      if (result.rows.length === 0) {
        return done(null, false);
      }
      done(null, result.rows[0]);
    } catch (error) {
      logger.error('Passport deserialize error:', error);
      done(error, null);
    }
  });

  // Only configure Google OAuth if credentials are available
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    logger.warn('⚠️  Google OAuth not configured - GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set');
    return;
  }

  // Google OAuth 2.0 Strategy
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/auth/google/callback',
        passReqToCallback: true, // Pass request to callback for additional context
        scope: ['profile', 'email'],
        accessType: 'offline', // Request refresh token
        prompt: 'consent', // Force consent screen to get refresh token
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          // Security: Validate profile data from Google
          if (!profile.id || !profile.emails || profile.emails.length === 0) {
            return done(new Error('Invalid Google profile data'), null);
          }

          const googleId = profile.id;
          const email = profile.emails[0].value;
          const displayName = profile.displayName || profile.name?.givenName || 'User';
          const avatarUrl = profile.photos?.[0]?.value || null;

          // Security: Normalize and validate email
          const normalizedEmail = email.toLowerCase().trim();
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(normalizedEmail)) {
            return done(new Error('Invalid email from Google'), null);
          }

          // Check if user exists with this Google ID
          let userResult = await query(
            'SELECT id, email FROM users WHERE google_id = $1',
            [googleId]
          );

          let user;
          if (userResult.rows.length > 0) {
            // Existing user - update last login timestamp
            user = userResult.rows[0];
            await query(
              'UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
              [user.id]
            );
          } else {
            // New user - check if email already exists
            const existingEmailResult = await query(
              'SELECT id, google_id FROM users WHERE email = $1',
              [normalizedEmail]
            );

            if (existingEmailResult.rows.length > 0) {
              const existingUser = existingEmailResult.rows[0];
              
              // If user exists but has no google_id, link the account
              if (!existingUser.google_id) {
                await query(
                  'UPDATE users SET google_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                  [googleId, existingUser.id]
                );
                user = existingUser;
              } else {
                // Email exists but with different Google ID - potential account hijack attempt
                logger.warn(`Google OAuth: Email ${normalizedEmail} already linked to different account`);
                return done(new Error('Email already associated with another account'), null);
              }
            } else {
              // Create new user
              const createResult = await query(
                `INSERT INTO users (email, google_id, display_name, avatar_url, email_verified, subscription_tier)
                 VALUES ($1, $2, $3, $4, TRUE, 'free')
                 RETURNING id, email, display_name, avatar_url, subscription_tier`,
                [normalizedEmail, googleId, displayName, avatarUrl]
              );
              user = createResult.rows[0];
            }
          }

          // Fetch full user data
          const fullUserResult = await query(
            'SELECT id, email, display_name, avatar_url, subscription_tier FROM users WHERE id = $1',
            [user.id]
          );

          return done(null, fullUserResult.rows[0]);
        } catch (error) {
          logger.error('Google OAuth strategy error:', error);
          return done(error, null);
        }
      }
    )
  );
}

export default passport;
