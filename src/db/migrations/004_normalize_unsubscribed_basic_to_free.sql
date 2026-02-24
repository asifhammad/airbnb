UPDATE users u
SET subscription_tier = 'free',
    updated_at = CURRENT_TIMESTAMP
WHERE u.subscription_tier = 'basic'
  AND NOT EXISTS (
    SELECT 1
    FROM subscriptions s
    WHERE s.user_id = u.id
      AND s.status IN ('active', 'trialing')
  );
