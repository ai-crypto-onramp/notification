# Notification

![CI](https://github.com/ai-crypto-onramp/notification/actions/workflows/ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/ai-crypto-onramp/notification/branch/main/graph/badge.svg)](https://codecov.io/gh/ai-crypto-onramp/notification)

Email/SMS/push + partner webhooks for tx status.

## Overview / Responsibilities

The Notification service is the platform's outbound messaging layer. It runs
**asynchronously** off the transaction path, consuming events from the
Transaction Orchestrator and the Blockchain Gateway and fanning them out across
channels to end users and partner systems. It is intentionally decoupled from the
saga so that delivery slowness or channel outage never blocks payment, signing,
or broadcast.

Responsibilities:

- Route outbound messages across channels (email, SMS, push, partner webhook)
  based on event type and per-user preferences.
- Render templated messages per lifecycle event (tx created, payment captured,
  signed, confirmed, failed, refunded).
- Deliver partner webhooks with HMAC-signed payloads and retries.
- Track per-message delivery status (sent / delivered / failed / bounced).
- Enforce opt-out and compliance rules (e.g. marketing vs transactional
  separation, regional quiet hours).
- Guarantee idempotent sends and batch high-volume webhooks.
- Emit notification lifecycle events to the Audit / Event Log.

## Language & Tech Stack

| Layer | Choice |
|---|---|
| Language / Runtime | TypeScript on Node.js |
| Email | Amazon SES |
| SMS | Amazon SNS (US) / Twilio (international) |
| Push | Firebase Cloud Messaging (FCM) — Android; APNS — iOS |
| Partner webhooks | Outbound HTTP POST with HMAC-SHA256 signer |
| Templating | Handlebars |
| Persistence | PostgreSQL |
| Dedup / rate limit | Redis |
| Event ingestion | Event bus consumer (async) |

## System Requirements

1. **Channel routing** — for each event, resolve the channel set from the
   event type and the recipient's `user_preferences`:
   - `email` → SES
   - `sms` → SNS / Twilio
   - `push` → FCM / APNS
   - `webhook` → registered partner endpoint(s)
   A single event may fan out to multiple channels (e.g. email + push for a
   confirmed tx).
2. **Templated messages per event** — Handlebars templates keyed by event
   type, covering at minimum:
   - `tx.created`
   - `payment.captured`
   - `tx.signed`
   - `tx.confirmed`
   - `tx.failed`
   - `tx.refunded`
   Each template renders localized, channel-specific content (e.g. short SMS
   body vs. rich HTML email).
3. **Partner webhooks** — POST signed JSON payloads to registered partner
   endpoints. Support HMAC signing, exponential-backoff retries, and
   per-attempt status capture.
4. **Delivery status tracking** — record every `delivery_attempt` (channel,
   provider message id, status, timestamps) and expose status endpoints for
   internal consumers and partners.
5. **Opt-out / compliance** — honor per-user channel opt-outs, distinguish
   transactional vs marketing traffic, and respect regional quiet hours for
   non-time-sensitive sends.
6. **Idempotent sends** — dedup on a stable notification key
   (`event_id + channel + recipient`) so redelivered upstream events do not
   produce duplicate outbound messages.
7. **Batching for high-volume webhooks** — coalesce partner webhook deliveries
   per partner window to reduce call count during spikes (e.g. broadcast
   confirmations).

## Non-Functional Requirements

- **Send latency:** < 30s end-to-end for time-sensitive events (`tx.confirmed`,
  `tx.failed`) from event ingestion to provider handoff.
- **Delivery retries:** exponential backoff (e.g. 1s, 5s, 30s, 2m, 10m) up to a
  bounded max-attempts ceiling per channel.
- **Delivery semantics:** at-least-once, with dedup on the notification key so
  effective-once for end users.
- **Availability:** 99.95% for the send API and event consumer; channel
  providers are treated as eventually-available (queued, retried).
- **Per-channel rate limits:** configurable per-provider rate limits enforced
  via Redis token buckets to avoid SES/SNS/FCM throttling and partner overload.

## Technical Specifications

### API surface

- **Admin REST API** — synchronous endpoints for lookup, preference
  management, and partner delivery confirmations.
- **Async event consumer** — subscribes to the event bus and processes
  `tx.*` and `chain.*` events off the transaction path.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/notifications/send` | Internal: enqueue a notification (used by other services for non-event-driven sends). |
| `GET` | `/v1/notifications/:id` | Fetch a notification record by id. |
| `GET` | `/v1/notifications/:id/status` | Fetch aggregated delivery status across channels. |
| `POST` | `/v1/preferences/:user_id` | Set per-user channel preferences and opt-outs. |
| `POST` | `/v1/webhooks/partners` | Partner delivery confirmation callback (ack / failure). |

### Data model

- **notifications** — one row per outbound message: id, event_id, channel,
  recipient, template_id, status, created_at, sent_at.
- **notification_templates** — Handlebars templates keyed by event type +
  channel + locale.
- **delivery_attempts** — one row per provider attempt: notification_id,
  channel, provider, provider_message_id, status, attempt_no, error,
  timestamps.
- **user_preferences** — per-user channel opt-in/opt-out, locale, quiet-hours.
- **partner_webhooks** — registered partner endpoints: url, secret,
  event_filters, retry_policy, batch_window, status.

### Event subscriptions

| Event | Emitted by | Use |
|---|---|---|
| `tx.created` | transaction-orchestrator | Notify user their purchase was accepted. |
| `payment.captured` | transaction-orchestrator | Confirm fiat capture. |
| `tx.signed` | transaction-orchestrator | (Optional) signing milestone. |
| `tx.confirmed` | blockchain-gateway (`chain.confirmed`) | On-chain confirmation → primary success notification. |
| `tx.failed` | transaction-orchestrator | Failure notification + reason. |
| `tx.refunded` | transaction-orchestrator | Refund confirmation. |

### Channel abstraction

A `Channel` interface normalizes providers behind a single send contract:

```ts
interface Channel {
  readonly name: "email" | "sms" | "push" | "webhook";
  send(message: NotificationMessage): Promise<DeliveryReceipt>;
  verifyPreference(pref: UserPreferences): boolean;
}
```

Implementations: `EmailChannel` (SES), `SmsChannel` (SNS / Twilio),
`PushChannel` (FCM / APNS), `WebhookChannel` (signed HTTP POST). The router
selects channels from `user_preferences` + event type and fans out.

### Integrations

- **Consumes events** from `transaction-orchestrator` (`tx.*`) and
  `blockchain-gateway` (`chain.confirmed`) over the event bus.
- **Calls providers** — SES (email), SNS / Twilio (SMS), FCM / APNS (push).
- **Posts signed webhooks** to registered partner endpoints.
- **Emits lifecycle events** to `audit-event-log` (notification.requested,
  notification.delivered, notification.failed).

### Webhook signing

Outbound partner webhooks are signed with **HMAC-SHA256** over
`timestamp + "." + raw_body` using a per-partner shared secret. Headers:

```
X-Webhook-Timestamp: 1700000000
X-Webhook-Signature: <hex(hmac_sha256(secret, "1700000000." + body))>
X-Webhook-Event: tx.confirmed
```

Partners verify by recomputing the HMAC and rejecting requests whose timestamp
is outside their acceptance window (recommended ±5 min) to prevent replays.

## Dependencies

| Dependency | Purpose |
|---|---|
| PostgreSQL | Primary store for notifications, templates, attempts, preferences, partner webhooks. |
| Redis | Dedup keys, per-channel rate-limit token buckets, retry backoff state. |
| Amazon SES | Email provider. |
| Amazon SNS | SMS provider (primary, US). |
| Twilio | SMS provider (international). |
| Firebase Cloud Messaging (FCM) | Android push. |
| APNS | iOS push. |
| audit-event-log | Sink for notification lifecycle audit events. |
| transaction-orchestrator | Source of `tx.*` events. |
| blockchain-gateway | Source of `chain.confirmed` events. |

## Configuration

Environment variables:

| Variable | Description | Example |
|---|---|---|
| `PORT` | HTTP port for the admin REST API. | `8080` |
| `DB_URL` | PostgreSQL connection string. | `postgres://user:pass@db:5432/notification` |
| `REDIS_URL` | Redis connection string (dedup + rate limits). | `redis://redis:6379` |
| `SES_REGION` | AWS region for SES. | `us-east-1` |
| `SES_FROM` | Verified sender address for SES. | `no-reply@onramp.example` |
| `SNS_REGION` | AWS region for SNS SMS. | `us-east-1` |
| `TWILIO_SID` | Twilio account SID. | `AC...` |
| `TWILIO_TOKEN` | Twilio auth token. | `...` |
| `TWILIO_FROM` | Twilio sender number. | `+15555550100` |
| `FCM_KEY` | Firebase server key / service-account JSON path. | `...` |
| `APNS_TEAM_ID` | Apple developer team id. | `ABCDE12345` |
| `APNS_KEY_ID` | APNS key id. | `ABCDE12345` |
| `APNS_PRIVATE_KEY_PATH` | Path to APNS private key (.p8). | `/secrets/apns.p8` |
| `APNS_BUNDLE_ID` | App bundle id for push topics. | `com.example.onramp` |
| `PARTNER_WEBHOOK_SECRET` | Default HMAC secret for partner webhooks (overridable per partner). | `...` |
| `WEBHOOK_MAX_ATTEMPTS` | Max retry attempts for partner webhooks. | `5` |
| `WEBHOOK_BATCH_WINDOW_MS` | Batching window for high-volume partner webhooks. | `1000` |
| `EVENT_CONSUMER_GROUP` | Consumer group name on the event bus. | `notification` |
| `EVENT_BUS_URL` | Event bus broker endpoint. | `nats://broker:4222` |
| `AUDIT_EVENT_LOG_URL` | audit-event-log ingest endpoint. | `http://audit:8080/v1/events` |
| `RATE_LIMIT_EMAIL_RPS` | SES send rate cap. | `14` |
| `RATE_LIMIT_SMS_RPS` | SMS send rate cap. | `10` |
| `RATE_LIMIT_PUSH_RPS` | Push send rate cap. | `50` |
| `LOG_LEVEL` | Logging level. | `info` |

## Local Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run (requires PostgreSQL + Redis reachable, or docker-compose up)
npm run dev

# Run tests
npm test

# Lint
npm run lint

# Typecheck
npm run typecheck
```
