-- Migration: Fix column types for Stripe integration and subscription tiers
-- This ensures all columns that store values longer than 1 character are properly sized

-- Fix subscription_tier and subscription_status columns (were CHAR(1), need to be VARCHAR(20))
ALTER TABLE users
  ALTER COLUMN subscription_tier TYPE VARCHAR(20),
  ALTER COLUMN subscription_status TYPE VARCHAR(20);

-- Ensure stripe_customer_id is properly sized for Stripe customer IDs (cus_* format)
-- These are typically 18+ characters, so VARCHAR(255) is appropriate
ALTER TABLE users
  ALTER COLUMN stripe_customer_id TYPE VARCHAR(255);

-- Same for stripe_subscription_id and stripe_price_id
ALTER TABLE users
  ALTER COLUMN stripe_subscription_id TYPE VARCHAR(255),
  ALTER COLUMN stripe_price_id TYPE VARCHAR(255);

-- Verify changes
SELECT column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE table_name = 'users'
  AND column_name IN ('subscription_tier', 'subscription_status', 'stripe_customer_id', 'stripe_subscription_id', 'stripe_price_id')
ORDER BY ordinal_position;
