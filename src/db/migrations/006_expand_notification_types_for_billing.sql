-- Allow billing-related notification types for Dreamlit email triggers.
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_notification_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_notification_type_check
  CHECK (notification_type IN (
    'new_listing',
    'availability_change',
    'price_drop',
    'subscription_started',
    'subscription_updated',
    'subscription_canceled',
    'invoice_payment_failed'
  ));
