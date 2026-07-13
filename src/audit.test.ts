import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  RecordingAuditEmitter,
  HttpAuditEmitter,
  getAuditEmitter,
  setAuditEmitter,
  initAuditEmitterFromEnv,
  recordAudit,
} from "./audit.js";
import { store, makeId } from "./store.js";

describe("RecordingAuditEmitter", () => {
  it("records emitted events", async () => {
    const e = new RecordingAuditEmitter();
    const evt = {
      id: "a1", type: "notification.delivered" as const, notification_id: "n1",
      channel: "email" as const, status: "delivered" as const,
      created_at: new Date().toISOString(), payload: {},
    };
    await e.emit(evt);
    expect(e.recorded).toEqual([evt]);
  });
});

describe("HttpAuditEmitter", () => {
  it("POSTs the event to the configured URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    const e = new HttpAuditEmitter("http://audit.example/v1/events", fetchMock as never);
    const evt = {
      id: "a2", type: "notification.delivered" as const, notification_id: "n2",
      channel: "sms" as const, status: "delivered" as const,
      created_at: new Date().toISOString(), payload: {},
    };
    await e.emit(evt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://audit.example/v1/events");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).id).toBe("a2");
  });

  it("swallows fetch failures without throwing", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const e = new HttpAuditEmitter("http://audit.example/v1/events", fetchMock as never);
    const evt = {
      id: "a3", type: "notification.failed" as const, notification_id: "n3",
      channel: "email" as const, status: "failed" as const,
      created_at: new Date().toISOString(), payload: {},
    };
    await expect(e.emit(evt)).resolves.toBeUndefined();
  });

  it("warns on non-OK response without throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("oops", { status: 500 }),
    );
    const e = new HttpAuditEmitter("http://audit.example/v1/events", fetchMock as never);
    await e.emit({
      id: "a4", type: "notification.delivered" as const, notification_id: "n4",
      channel: "email" as const, status: "delivered" as const,
      created_at: new Date().toISOString(), payload: {},
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("audit emitter singleton", () => {
  afterEach(() => setAuditEmitter(new RecordingAuditEmitter()));

  it("getAuditEmitter/setAuditEmitter round-trip", () => {
    const custom = new RecordingAuditEmitter();
    setAuditEmitter(custom);
    expect(getAuditEmitter()).toBe(custom);
  });

  it("initAuditEmitterFromEnv uses HttpAuditEmitter when URL is set", () => {
    process.env.AUDIT_EVENT_LOG_URL = "http://audit.example/v1/events";
    const e = initAuditEmitterFromEnv();
    expect(e).toBeInstanceOf(HttpAuditEmitter);
    delete process.env.AUDIT_EVENT_LOG_URL;
  });

  it("initAuditEmitterFromEnv uses RecordingAuditEmitter when URL is unset", () => {
    delete process.env.AUDIT_EVENT_LOG_URL;
    const e = initAuditEmitterFromEnv();
    expect(e).toBeInstanceOf(RecordingAuditEmitter);
  });
});

describe("recordAudit", () => {
  beforeEach(() => store.reset());

  it("records in store AND emits via the active emitter", async () => {
    const rec = new RecordingAuditEmitter();
    setAuditEmitter(rec);
    const evt = {
      id: makeId("audit"), type: "notification.requested" as const, notification_id: "n",
      channel: "email" as const, status: "pending" as const,
      created_at: new Date().toISOString(), payload: {},
    };
    await recordAudit(evt);
    expect(store.audit).toContain(evt);
    expect(rec.recorded).toContain(evt);
  });
});