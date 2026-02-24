-- Fix column types for users table
-- This migration changes subscription_tier and subscription_status from CHAR(1) to VARCHAR(20)

-- First, check current column types (for debugging)
SELECT column_name, data_type, character_maximum_length 
FROM information_schema.columns 
WHERE table_name = 'users' AND column_name IN ('subscription_tier', 'subscription_status');

-- Alter column types to support longer values ('free', 'basic', 'premium' instead of single chars)
ALTER TABLE users ALTER COLUMN subscription_tier TYPE VARCHAR(20);
ALTER TABLE users ALTER COLUMN subscription_status TYPE VARCHAR(20);

-- Verify the changes
SELECT column_name, data_type, character_maximum_length 
FROM information_schema.columns 
WHERE table_name = 'users' AND column_name IN ('subscription_tier', 'subscription_status');
