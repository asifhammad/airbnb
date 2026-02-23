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
