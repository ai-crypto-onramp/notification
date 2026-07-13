# Project Plan — Notification

Implementation plan for the Notification service: the platform's asynchronous
outbound messaging layer (email / SMS / push / partner webhooks) driven by
`tx.*` and `chain.confirmed` events. Stages are ordered so each builds on the
primitives introduced by the previous one, ending with tests, coverage, and
containerization.

## Stage 1: Database schema & migrations

**Goal:** Establish the PostgreSQL foundation with tables for notifications,
templates, delivery attempts, user preferences, and partner webhooks.

**Tasks:**
- [x] Create `notifications` table (id, event_id, channel, recipient, template_id, status, created_at, sent_at).
- [x] Create `notification_templates` table keyed by event type + channel + locale.
- [x] Create `delivery_attempts` table (notification_id, channel, provider, provider_message_id, status, attempt_no, error, timestamps).
- [x] Create `user_preferences` table (per-user channel opt-in/opt-out, locale, quiet hours).
- [x] Create `partner_webhooks` table (url, secret, event_filters, retry_policy, batch_window, status).
- [x] Add indexes on `notifications(event_id, channel, recipient)` and `delivery_attempts(notification_id, attempt_no)`.
- [x] Add a migration runner and seed the six lifecycle templates.

**Acceptance criteria:**
- `npm run migrate` applies all migrations cleanly against an empty DB.
- All five tables exist with the columns described in the README data model.
- Seed templates for `tx.created`, `payment.captured`, `tx.signed`,
  `tx.confirmed`, `tx.failed`, `tx.refunded` are present.

## Stage 2: Kafka event consumer

**Goal:** Ingest `tx.*` and `chain.confirmed` events from the event bus with a
dedicated consumer group and dispatch them to a processing pipeline.

**Tasks:**
- [x] Implement an event bus consumer using `EVENT_CONSUMER_GROUP` / `EVENT_BUS_URL`.
- [x] Subscribe to `tx.created`, `payment.captured`, `tx.signed`, `tx.confirmed`, `tx.failed`, `tx.refunded`, `chain.confirmed`.
- [x] Normalize inbound events into an internal `InboundEvent` shape.
- [x] Push events onto an internal processing queue (in-memory or Redis-backed).
- [x] Add health/readiness reporting tied to consumer lag.

**Acceptance criteria:**
- Consumer joins the `notification` consumer group and replays from last acked offset on restart.
- Malformed events are dead-lettered without crashing the consumer.
- Readiness probe fails while the consumer is not subscribed.

## Stage 3: Template engine (Handlebars) & per-event templates

**Goal:** Render localized, channel-specific message bodies from Handlebars
templates keyed by event type + channel + locale.

**Tasks:**
- [x] Integrate Handlebars with a safe helper set (no raw HTML injection in SMS/push).
- [x] Implement a `TemplateService` that resolves a template by `(eventType, channel, locale)` with fallback to a default locale.
- [x] Render subject, text body, and HTML body variants for email.
- [x] Render short-body variants for SMS and push.
- [x] Cache compiled templates in-memory with invalidation on template update.

**Acceptance criteria:**
- All six lifecycle events render for every channel without missing-variable errors.
- Locale fallback picks the default locale when the requested locale is absent.
- Output is logged for review and free of unescaped Handlebars syntax.

## Stage 4: Channel abstraction (Email / SMS / Push / Webhook)

**Goal:** Define the `Channel` interface and route events to the correct channel
set based on event type and user preferences.

**Tasks:**
- [x] Define the `Channel` interface (`name`, `send`, `verifyPreference`) per README.
- [x] Implement a `ChannelRouter` that resolves channels from `user_preferences` + event type.
- [x] Support fan-out (e.g. email + push for `tx.confirmed`).
- [x] Implement a `NotificationMessage` shape carrying rendered content + recipient metadata.
- [x] Stub provider implementations behind the interface for stage 5–7 wiring.

**Acceptance criteria:**
- Router returns the expected channel set for each lifecycle event given a preference set.
- Channels with opted-out users are filtered out before send.
- Interface compiles and unit tests cover routing decisions.

## Stage 5: SES email + SNS/Twilio SMS delivery

**Goal:** Wire real providers for email (Amazon SES) and SMS (Amazon SNS for US,
Twilio for international).

**Tasks:**
- [x] Implement `EmailChannel` using SES with `SES_FROM` and `SES_REGION`.
- [x] Implement `SmsChannel` with SNS (US) / Twilio (international) selection.
- [x] Enforce per-channel rate limits via Redis token buckets.
- [x] Capture provider message id and map provider errors to attempt status.
- [x] Add configuration loaders for all SES/SNS/Twilio env vars.

**Acceptance criteria:**
- A notification routed to email produces a SES message id captured in `delivery_attempts`.
- International recipients route through Twilio; US recipients through SNS.
- Sends above the configured RPS are throttled without dropping messages.

## Stage 6: FCM/APNS push delivery

**Goal:** Deliver push notifications to Android (FCM) and iOS (APNS) devices.

**Tasks:**
- [x] Implement `PushChannel` with FCM for Android and APNS for iOS.
- [x] Resolve device tokens from recipient metadata / user preferences.
- [x] Honor platform-specific payload shapes (notification vs data messages).
- [x] Capture provider message ids and map failure reasons (invalid token, unregistered).
- [x] Enforce the push rate limit via Redis token bucket.

**Acceptance criteria:**
- Android and iOS payloads are correctly formatted per provider spec.
- Invalid-token errors are surfaced as failed attempts with a clear reason.
- Push sends respect `RATE_LIMIT_PUSH_RPS`.

## Stage 7: Partner webhooks with HMAC signing & retries

**Goal:** POST signed JSON payloads to registered partner endpoints with
exponential-backoff retries and per-attempt status capture.

**Tasks:**
- [x] Implement `WebhookChannel` that loads partner endpoints from `partner_webhooks`.
- [x] Sign payloads with HMAC-SHA256 over `timestamp + "." + raw_body` and emit `X-Webhook-Timestamp`, `X-Webhook-Signature`, `X-Webhook-Event`.
- [x] Apply exponential backoff (1s, 5s, 30s, 2m, 10m) up to `WEBHOOK_MAX_ATTEMPTS`.
- [x] Capture per-attempt status and response codes in `delivery_attempts`.
- [x] Coalesce high-volume deliveries per `WEBHOOK_BATCH_WINDOW_MS` per partner.

**Acceptance criteria:**
- Partners can recompute the signature and verify the timestamp is within ±5 min.
- Failed deliveries retry with the documented backoff and stop at the max-attempts ceiling.
- A burst of `tx.confirmed` events is batched into a single webhook per partner window.

## Stage 8: User preferences & opt-out / compliance

**Goal:** Honor per-user channel opt-outs, distinguish transactional vs marketing
traffic, and respect regional quiet hours for non-time-sensitive sends.

**Tasks:**
- [x] Implement `POST /v1/preferences/:user_id` to set channel opt-in/opt-out, locale, quiet hours.
- [x] Tag each notification as `transactional` or `marketing`.
- [x] Skip marketing sends to opted-out users and during quiet hours.
- [x] Allow time-sensitive events (`tx.confirmed`, `tx.failed`) to bypass quiet hours.
- [x] Persist preference changes and expose them for router lookup.

**Acceptance criteria:**
- Opted-out channels are never sent for a user.
- Marketing sends are suppressed during the user's quiet-hours window.
- Time-sensitive transactional sends bypass quiet hours and are delivered.

## Stage 9: Delivery status tracking, dedup & audit emission

**Goal:** Track per-message delivery status, enforce idempotent sends, and emit
lifecycle events to the audit-event-log.

**Tasks:**
- [x] Implement `GET /v1/notifications/:id` and `GET /v1/notifications/:id/status`.
- [x] Implement `POST /v1/notifications/send` for non-event-driven internal sends.
- [x] Implement `POST /v1/webhooks/partners` for partner delivery confirmations.
- [x] Dedup on `event_id + channel + recipient` using a Redis key with TTL.
- [x] Record every `delivery_attempts` row with status transitions (sent / delivered / failed / bounced).
- [x] Emit `notification.requested`, `notification.delivered`, `notification.failed` to `AUDIT_EVENT_LOG_URL`.

**Acceptance criteria:**
- Duplicate upstream events produce no duplicate outbound messages.
- Status endpoint returns aggregated state across all channels and attempts.
- Audit events are emitted for every notification lifecycle transition.

## Stage 10: Tests, coverage & Docker

**Goal:** Reach full coverage of the send pipeline, achieve the configured
coverage threshold, and ship a production-ready container image.

**Tasks:**
- [x] Unit tests for router, template engine, channel implementations, signing, dedup.
- [x] Integration tests for the consumer → render → send → audit pipeline using test providers.
- [x] Contract tests for partner webhook signature verification.
- [x] Wire `npm test`, `npm run lint`, `npm run typecheck` into CI.
- [x] Reach the Codecov coverage threshold and keep the badge green.
- [x] Finalize Dockerfile and Makefile targets for build / test / run.

**Acceptance criteria:**
- `npm test` passes with coverage at or above the configured threshold.
- CI runs lint + typecheck + tests on every push.
- `docker build` produces a runnable image that starts the admin API and consumer.