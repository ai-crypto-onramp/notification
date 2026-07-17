import Fastify, { type FastifyInstance } from "fastify";
import { store, newId } from "./store.js";
import {
  upsertPreferences,
  getPreferences,
  ValidationError as PrefValidationError,
} from "./preferences.js";
import {
  enqueueEvent,
  manualSend,
  ValidationError as PipelineValidationError,
} from "./pipeline.js";
import {
  registerWebhook,
  verifyWebhookSignature,
  deliverWithBackoff,
  DEFAULT_BACKOFF_MS,
} from "./webhooks.js";
import { consumer } from "./consumer.js";
import type { ChannelName } from "./types.js";

export interface AppOptions {
  logger?: boolean;
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_req, reply) => {
    const report = consumer.readiness();
    const code = report.ready ? 200 : 503;
    return reply
      .code(code)
      .send({ status: report.ready ? "ready" : "not_ready", ...report });
  });

  // ---- Preferences ----
  app.get("/v1/preferences", async () => {
    return { preferences: store.listPreferences() };
  });

  app.post<{ Params: { user_id: string } }>(
    "/v1/preferences/:user_id",
    async (req, reply) => {
      try {
        const pref = upsertPreferences(req.params.user_id, req.body as never);
        return reply.status(201).send(pref);
      } catch (err) {
        return reply.status((err as PrefValidationError).status ?? 400).send({
          error: (err as Error).message,
        });
      }
    },
  );

  app.get<{ Params: { user_id: string } }>(
    "/v1/preferences/:user_id",
    async (req, reply) => {
      try {
        return getPreferences(req.params.user_id);
      } catch (err) {
        return reply.status((err as PrefValidationError).status ?? 404).send({
          error: (err as Error).message,
        });
      }
    },
  );

  // ---- Events ----
  app.post("/v1/events", async (req, reply) => {
    try {
      const event = req.body as never;
      const n = enqueueEvent(event);
      return reply.status(202).send({ accepted: true, queued: n });
    } catch (err) {
      return reply.status((err as PipelineValidationError).status ?? 400).send({
        error: (err as Error).message,
      });
    }
  });

  // ---- Notifications ----
  app.get("/v1/notifications", async () => {
    return { notifications: store.listNotifications() };
  });

  app.post("/v1/notifications/send", async (req, reply) => {
    try {
      const notif = manualSend(req.body as never);
      return reply.status(201).send(notif);
    } catch (err) {
      return reply.status((err as PipelineValidationError).status ?? 400).send({
        error: (err as Error).message,
      });
    }
  });

  app.get<{ Params: { id: string } }>(
    "/v1/notifications/:id",
    async (req, reply) => {
      const n = store.getNotification(req.params.id);
      if (!n) return reply.status(404).send({ error: "notification not found" });
      const attempts = store.attemptsFor(req.params.id);
      return { notification: n, attempts };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/notifications/:id/status",
    async (req, reply) => {
      const n = store.getNotification(req.params.id);
      if (!n) return reply.status(404).send({ error: "notification not found" });
      const attempts = store.attemptsFor(req.params.id);
      const byChannel: Record<string, { status: string; attempts: number; last_error: string | null }> = {};
      for (const a of attempts) {
        byChannel[a.channel] = {
          status: a.status,
          attempts: a.attempt_no,
          last_error: a.error,
        };
      }
      return {
        notification_id: n.id,
        overall_status: n.status,
        channels: byChannel,
      };
    },
  );

  // ---- Partner webhooks ----
  app.post("/v1/webhooks/partners", async (req, reply) => {
    try {
      const body = req.body as {
        url: string;
        secret: string;
        event_filters?: never;
        retry_policy?: never;
      };
      if (!body.url) return reply.status(400).send({ error: "url required" });
      if (!body.secret) return reply.status(400).send({ error: "secret required" });
      const wh = registerWebhook({
        url: body.url,
        secret: body.secret,
        event_filters: body.event_filters,
        retry_policy: body.retry_policy,
      });
      return reply.status(201).send(wh);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.get("/v1/webhooks/partners", async () => {
    return { webhooks: store.listWebhooks() };
  });

  app.post<{ Params: { id: string } }>(
    "/v1/webhooks/partners/:id/confirm",
    async (req, reply) => {
      const wh = store.getWebhook(req.params.id);
      if (!wh) return reply.status(404).send({ error: "webhook not found" });
      const body = req.body as { notification_id: string; status: string };
      if (!body.notification_id || !body.status) {
        return reply.status(400).send({ error: "notification_id and status required" });
      }
      const attempts = store.webhookDeliveries.get(body.notification_id) ?? [];
      attempts.push({
        attempt_no: attempts.length + 1,
        status: body.status,
        at: new Date().toISOString(),
      });
      store.webhookDeliveries.set(body.notification_id, attempts);
      const notif = store.getNotification(body.notification_id);
      if (notif) {
        notif.status = body.status as never;
        store.addAudit({
          id: newId(),
          type: "notification.delivered",
          notification_id: notif.id,
          channel: "WEBHOOK",
          status: body.status as never,
          created_at: new Date().toISOString(),
          payload: { confirmed_by: wh.id },
        });
      }
      return { confirmed: true, notification_id: body.notification_id, status: body.status };
    },
  );

  // ---- Audit ----
  app.get("/v1/audit-events", async () => {
    return { events: store.audit };
  });

  // ---- Webhook signature verification helper (test utility) ----
  app.post("/v1/webhooks/verify", async (req) => {
    const body = req.body as {
      secret: string;
      raw_body: string;
      timestamp: string;
      signature: string;
    };
    const ok = verifyWebhookSignature(
      body.secret,
      body.raw_body,
      body.timestamp,
      body.signature,
    );
    return { valid: ok };
  });

  // ---- Webhook delivery test endpoint (records backoff attempts) ----
  app.post<{ Params: { id: string } }>(
    "/v1/webhooks/partners/:id/deliver",
    async (req, reply) => {
      const wh = store.getWebhook(req.params.id);
      if (!wh) return reply.status(404).send({ error: "webhook not found" });
      const body = (req.body as { payload?: Record<string, unknown>; simulate_failure?: boolean }) ?? {};
      const result = await deliverWithBackoff(wh, body.payload ?? {}, body.simulate_failure);
      return result;
    },
  );

  return app;
}

export function rateLimitEnvInfo(): Record<string, number> {
  return {
    email: Number(process.env.RATE_LIMIT_EMAIL_RPS ?? 10),
    sms: Number(process.env.RATE_LIMIT_SMS_RPS ?? 5),
    push: Number(process.env.RATE_LIMIT_PUSH_RPS ?? 20),
    webhook_max_attempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 5),
  };
}

export { DEFAULT_BACKOFF_MS };
export type { ChannelName };