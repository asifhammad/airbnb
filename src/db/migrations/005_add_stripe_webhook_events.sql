CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id VARCHAR(255) PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_received
  ON stripe_webhook_events(received_at DESC);
