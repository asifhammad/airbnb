-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  supabase_user_id UUID UNIQUE,                       -- links local user to Supabase Auth user.id
  password_hash VARCHAR(255),                          -- NULL for Google-only accounts
  google_id VARCHAR(255) UNIQUE,                       -- Google OAuth sub
  display_name VARCHAR(255),
  avatar_url TEXT,
  email_verified BOOLEAN DEFAULT FALSE,
  subscription_tier VARCHAR(20) DEFAULT 'free' CHECK (subscription_tier IN ('free', 'basic', 'premium')),
  subscription_status VARCHAR(20) DEFAULT 'active' CHECK (subscription_status IN ('active', 'cancelled', 'expired')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscriptions table (Stripe subscription data)
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id VARCHAR(255) UNIQUE NOT NULL,
  stripe_price_id VARCHAR(255) NOT NULL,
  plan VARCHAR(50) NOT NULL CHECK (plan IN ('basic', 'premium')),
  interval VARCHAR(10) CHECK (interval IN ('month', 'year')),
  status VARCHAR(50) NOT NULL CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired')),
  current_period_end TIMESTAMP,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_id ON subscriptions(stripe_subscription_id);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash VARCHAR(128) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,                                   -- NULL = not yet used
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

-- Refresh tokens (for token rotation)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(128) UNIQUE NOT NULL,
  token_prefix VARCHAR(16) NOT NULL DEFAULT '',        -- first 16 chars of raw token, for indexed lookup
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,                                -- NULL = not revoked; set when user logs out
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Migration: add token_prefix if upgrading an existing database (safe no-op if already present)
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_prefix VARCHAR(16) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_prefix ON refresh_tokens(token_prefix);

-- Search alerts table
CREATE TABLE IF NOT EXISTS search_alerts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  alert_type VARCHAR(20) DEFAULT 'search' CHECK (alert_type IN ('search', 'listing')),
  
  -- For search-based alerts
  location VARCHAR(255),
  check_in DATE,
  check_out DATE,
  ne_lat DECIMAL(10, 8),
  ne_long DECIMAL(11, 8),
  sw_lat DECIMAL(10, 8),
  sw_long DECIMAL(11, 8),
  price_min INTEGER,
  price_max INTEGER,
  guests INTEGER,
  place_type VARCHAR(50),
  amenities JSONB,
  free_cancellation BOOLEAN DEFAULT FALSE,
  
  -- For specific listing alerts
  listing_id VARCHAR(100),
  listing_url TEXT,
  
  -- Metadata
  is_active BOOLEAN DEFAULT TRUE,
  last_checked TIMESTAMP,
  last_notified TIMESTAMP,
  notification_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- For free tier alerts (24-hour limitation)
  is_free_trial BOOLEAN DEFAULT FALSE,
  expires_at TIMESTAMP
);

-- Listings table (cache of discovered listings)
CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY,
  listing_id VARCHAR(100) UNIQUE NOT NULL,
  url TEXT,
  name TEXT,
  price DECIMAL(10, 2),
  currency VARCHAR(10) DEFAULT 'USD',
  rating DECIMAL(3, 2),
  num_reviews INTEGER,
  room_type VARCHAR(100),
  guests INTEGER,
  bedrooms INTEGER,
  beds INTEGER,
  bathrooms DECIMAL(3, 1),
  address TEXT,
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  amenities JSONB,
  host_id VARCHAR(100),
  host_name VARCHAR(255),
  photos JSONB,
  availability_hash VARCHAR(64),
  is_available BOOLEAN DEFAULT TRUE,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Search results (mapping between searches and listings)
CREATE TABLE IF NOT EXISTS search_results (
  id SERIAL PRIMARY KEY,
  search_alert_id INTEGER REFERENCES search_alerts(id) ON DELETE CASCADE,
  listing_id VARCHAR(100) REFERENCES listings(listing_id) ON DELETE CASCADE,
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  change_type VARCHAR(20) CHECK (change_type IN ('new', 'freed_up', 'price_drop')),
  old_price DECIMAL(10, 2),
  new_price DECIMAL(10, 2),
  UNIQUE (search_alert_id, listing_id)
);

-- Extra columns added post-launch (safe to run on existing DBs)
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_price_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_period_end TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_user_id UUID;

-- Migrate subscription columns to correct types (if previously CHAR(1))
ALTER TABLE users ALTER COLUMN subscription_tier TYPE VARCHAR(20);
ALTER TABLE users ALTER COLUMN subscription_status TYPE VARCHAR(20);

ALTER TABLE search_alerts ADD COLUMN IF NOT EXISTS search_url TEXT;
ALTER TABLE search_alerts ADD COLUMN IF NOT EXISTS url_params JSONB;
ALTER TABLE search_alerts ADD COLUMN IF NOT EXISTS instant_book BOOLEAN DEFAULT FALSE;
ALTER TABLE search_alerts ADD COLUMN IF NOT EXISTS guest_favorite BOOLEAN DEFAULT FALSE;
ALTER TABLE search_alerts ADD COLUMN IF NOT EXISTS min_beds INTEGER;
ALTER TABLE search_alerts ADD COLUMN IF NOT EXISTS infants INTEGER;
ALTER TABLE search_alerts ADD COLUMN IF NOT EXISTS monthly_search BOOLEAN DEFAULT FALSE;

-- Price history (append-only, one row per scrape run per listing per alert)
CREATE TABLE IF NOT EXISTS listing_price_history (
  id SERIAL PRIMARY KEY,
  listing_id VARCHAR(100) REFERENCES listings(listing_id) ON DELETE CASCADE,
  search_alert_id INTEGER REFERENCES search_alerts(id) ON DELETE CASCADE,
  price DECIMAL(10, 2) NOT NULL,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_price_history_listing ON listing_price_history(listing_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_price_history_alert  ON listing_price_history(search_alert_id, recorded_at);

-- Notifications log
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  search_alert_id INTEGER REFERENCES search_alerts(id) ON DELETE CASCADE,
  listing_id VARCHAR(100),
  notification_type VARCHAR(20) CHECK (notification_type IN ('new_listing', 'availability_change', 'price_drop')),
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  email_sent BOOLEAN DEFAULT FALSE,
  email_error TEXT
);

-- Audit logs for tracking sensitive operations
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  resource VARCHAR(100),
  resource_id INTEGER,
  details JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  status VARCHAR(20) DEFAULT 'success' CHECK (status IN ('success', 'failure')),
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_supabase_user_id ON users(supabase_user_id);
CREATE INDEX IF NOT EXISTS idx_search_alerts_user_id ON search_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_search_alerts_active ON search_alerts(is_active);
CREATE INDEX IF NOT EXISTS idx_listings_listing_id ON listings(listing_id);
CREATE INDEX IF NOT EXISTS idx_listings_location ON listings(lat, lng);
CREATE INDEX IF NOT EXISTS idx_search_results_search_id ON search_results(search_alert_id);
CREATE INDEX IF NOT EXISTS idx_search_results_listing_id ON search_results(listing_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_prefix ON refresh_tokens(token_prefix);

-- Transactional email events (DB-driven queue for external email workflows, e.g. Dreamlit)
CREATE TABLE IF NOT EXISTS transactional_email_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_email VARCHAR(255) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  payload JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tx_email_events_status_created
  ON transactional_email_events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_email_events_event_type
  ON transactional_email_events(event_type);
