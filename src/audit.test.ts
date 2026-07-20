import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  RecordingAuditEmitter,
  getAuditEmitter,
  setAuditEmitter,
  initAuditEmitterFromEnv,
  recordAudit,
} from "./audit.js";
import { store, newId } from "./store.js";

describe("RecordingAuditEmitter", () => {
  it("records emitted events", async () => {
    const e = new RecordingAuditEmitter();
    const evt = {
      id: "a1", type: "notification.delivered" as const, notification_id: "n1",
      channel: "EMAIL" as const, status: "DELIVERED" as const,
      created_at: new Date().toISOString(), payload: {},
    };
    await e.emit(evt);
    expect(e.recorded).toEqual([evt]);
  });
});

describe("audit emitter singleton", () => {
  afterEach(() => setAuditEmitter(new RecordingAuditEmitter()));

  it("getAuditEmitter/setAuditEmitter round-trip", () => {
    const custom = new RecordingAuditEmitter();
    setAuditEmitter(custom);
    expect(getAuditEmitter()).toBe(custom);
  });

  it("initAuditEmitterFromEnv uses RecordingAuditEmitter when KAFKA_BROKERS unset and DEV_MODE=1", () => {
    delete process.env.KAFKA_BROKERS;
    process.env.DEV_MODE = "1";
    const e = initAuditEmitterFromEnv();
    expect(e).toBeInstanceOf(RecordingAuditEmitter);
    delete process.env.DEV_MODE;
  });

  it("initAuditEmitterFromEnv uses RecordingAuditEmitter when URL is unset", () => {
    delete process.env.KAFKA_BROKERS;
    process.env.DEV_MODE = "1";
    const e = initAuditEmitterFromEnv();
    expect(e).toBeInstanceOf(RecordingAuditEmitter);
    delete process.env.DEV_MODE;
  });
});

describe("recordAudit", () => {
  beforeEach(() => store.reset());

  it("records in store AND emits via the active emitter", async () => {
    const rec = new RecordingAuditEmitter();
    setAuditEmitter(rec);
    const evt = {
      id: newId(), type: "notification.requested" as const, notification_id: "n",
      channel: "EMAIL" as const, status: "PENDING" as const,
      created_at: new Date().toISOString(), payload: {},
    };
    await recordAudit(evt);
    expect(store.audit).toContain(evt);
    expect(rec.recorded).toContain(evt);
  });
});