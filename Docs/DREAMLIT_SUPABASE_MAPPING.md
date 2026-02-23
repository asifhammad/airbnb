# Dreamlit <> Backend Mapping (Current State)

## Scope
This maps the current backend behavior to the Dreamlit workflows shown in the client screenshot (Supabase Auth triggers):

- Invite User (`supabase.auth.admin.inviteUserByEmail()`)
- Reauthentication (`supabase.auth.reauthenticate()`)
- Confirm Signup (`supabase.auth.signUp()`)
- Change Email (`supabase.auth.updateUser({ email })`)
- Magic Link (`supabase.auth.signInWithOtp()`)
- Reset Password (`supabase.auth.resetPasswordForEmail()`)

## Current Backend Auth Model (After Migration Patch)
- Backend session remains custom JWT + cookies, implemented in `src/routes/auth.js`.
- Identity provider for email/password flows is now Supabase Auth REST.
- Local `users` table is linked via `users.supabase_user_id` (UUID).
- Login/registration happen via existing endpoints, but call Supabase under the hood:
  - `POST /api/auth/register`
  - `POST /api/auth/login`
  - `POST /api/auth/refresh`
  - `POST /api/auth/logout`
- Password reset request now calls Supabase recover API:
  - `POST /api/auth/forgot-password` -> `/auth/v1/recover`
- Added explicit endpoints to trigger matching Dreamlit flows:
  - `POST /api/auth/magic-link`
  - `POST /api/auth/change-email`
  - `POST /api/auth/reauthenticate`
  - `POST /api/auth/invite` (admin-secret protected)
- Google OAuth is still Passport-based (`/api/auth/google`) and does not emit Supabase Auth events.

## Match Matrix

| Dreamlit Workflow Trigger | Backend Equivalent Now | Match? | Notes |
|---|---|---|---|
| `supabase.auth.admin.inviteUserByEmail()` | `POST /api/auth/invite` -> `/auth/v1/invite` | Yes | Requires `x-admin-secret` |
| `supabase.auth.reauthenticate()` | `POST /api/auth/reauthenticate` (password recheck against Supabase) | Partial | Backend-safe equivalent; not direct `/reauthenticate` endpoint |
| `supabase.auth.signUp()` | `POST /api/auth/register` -> `/auth/v1/signup` | Yes | Existing frontend flow preserved |
| `supabase.auth.updateUser({ email })` | `POST /api/auth/change-email` -> `/auth/v1/admin/users/:id` | Yes | Uses service-role admin update |
| `supabase.auth.signInWithOtp()` | `POST /api/auth/magic-link` -> `/auth/v1/otp` | Yes | `create_user=false` |
| `supabase.auth.resetPasswordForEmail()` | `POST /api/auth/forgot-password` -> `/auth/v1/recover` | Yes | Generic response retained |

## Notification/Email Flow Mapping (Non-Auth)

Current alert notifications are generated in worker code, then logged to `notifications`:

- Processor: `src/workers/scraper-worker.js`
- Notification table writes:
  - `notification_type`: `new_listing`, `price_drop`, `availability_change`
  - `email_sent`: `true/false`
  - `email_error`: error text on failure
  - `payload`: JSON context for the event
- Email sending provider currently: Nodemailer (`src/services/email.js`)

This means Dreamlit Auth workflows do **not** cover app alert emails yet.

## Bottom Line

The backend auth API now routes key auth operations through Supabase Auth so Dreamlit Supabase Auth workflows can trigger while keeping existing app endpoints.

## Required Environment

Set all of:
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`

Legacy fallback also supported in code:
- `SUPABASE_ANON_KEY` (publishable fallback)
- `SUPABASE_SERVICE_ROLE_KEY` (secret fallback)
