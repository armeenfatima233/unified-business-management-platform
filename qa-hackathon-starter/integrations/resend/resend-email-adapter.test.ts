import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { Resend } from "resend";
import type {
  CreateEmailResponse,
  GetReceivingEmailResponse,
} from "resend";
import {
  ResendApiError,
  ResendEmailAdapter,
  ResendProtocolError,
  ResendTransportError,
  ResendWebhookAuthenticationError,
  ResendWebhookPayloadError,
  createResendEmailAdapterFromEnvironment,
  type ResendSdkClient,
} from "./resend-email-adapter.ts";
import type {
  EmailDeliveryEvent,
  IncomingEmail,
  ResendWebhookEventDeduplicator,
  ResendWebhookHandlers,
} from "./types.ts";

const webhookSecret = `whsec_${Buffer.from("integration-test-secret").toString("base64")}`;

function receivedPayload(emailId = "received_123"): string {
  return JSON.stringify({
    type: "email.received",
    created_at: "2026-10-18T05:00:00.000Z",
    data: {
      email_id: emailId,
      created_at: "2026-10-18T04:59:00.000Z",
      from: "customer@example.test",
      to: ["support@example.test"],
      cc: [],
      bcc: [],
      received_for: ["support@example.test"],
      message_id: "<source-message@example.test>",
      subject: "Help needed",
      attachments: [],
    },
  });
}

function deliveryPayload(type = "email.delivered"): string {
  return JSON.stringify({
    type,
    created_at: "2026-10-18T05:00:00.000Z",
    data: {
      email_id: "sent_123",
      created_at: "2026-10-18T04:59:00.000Z",
      message_id: "<sent-message@example.test>",
      from: "support@example.test",
      to: ["customer@example.test"],
      subject: "Your request",
    },
  });
}

function signPayload(payload: string, id = "msg_test_123"): {
  "svix-id": string;
  "svix-timestamp": string;
  "svix-signature": string;
} {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const key = Buffer.from(webhookSecret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");

  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

function success<T>(data: T) {
  return { data, error: null, headers: null };
}

function apiError(): CreateEmailResponse {
  return {
    data: null,
    error: { name: "validation_error", statusCode: 422, message: "provider rejected request" },
    headers: null,
  };
}

function receivedEmailResponse(id = "received_123"): GetReceivingEmailResponse {
  return success({
    object: "email",
    id,
    to: ["support@example.test"],
    from: "customer@example.test",
    created_at: "2026-10-18T04:59:00.000Z",
    subject: "Help needed",
    bcc: [],
    cc: [],
    reply_to: null,
    received_for: ["support@example.test"],
    html: "<p>Help</p>",
    text: "Help",
    headers: { from: "Customer <customer@example.test>" },
    message_id: "<source-message@example.test>",
    attachments: [],
  });
}

class TestEventDeduplicator implements ResendWebhookEventDeduplicator {
  private readonly completed = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();

  async processOnce(providerEventId: string, work: () => Promise<void>): Promise<boolean> {
    if (this.completed.has(providerEventId)) {
      return false;
    }

    const activeWork = this.inFlight.get(providerEventId);
    if (activeWork !== undefined) {
      await activeWork;
      return false;
    }

    const pendingWork = work();
    this.inFlight.set(providerEventId, pendingWork);
    try {
      await pendingWork;
      this.completed.add(providerEventId);
    } catch (error) {
      throw error;
    } finally {
      this.inFlight.delete(providerEventId);
    }
    return true;
  }
}

function createAdapter(overrides: {
  send?: ResendSdkClient["emails"]["send"];
  getReceived?: ResendSdkClient["emails"]["receiving"]["get"];
  verify?: ResendSdkClient["webhooks"]["verify"];
  deduplicator?: ResendWebhookEventDeduplicator;
  onIncomingEmail?: (email: IncomingEmail) => Promise<void>;
  onDeliveryEvent?: (event: EmailDeliveryEvent) => Promise<void>;
} = {}) {
  const incoming: IncomingEmail[] = [];
  const deliveries: EmailDeliveryEvent[] = [];
  const client: ResendSdkClient = {
    emails: {
      send: overrides.send ?? (async () => success({ id: "sent_123" })),
      receiving: {
        get: overrides.getReceived ?? (async (id) => receivedEmailResponse(id)),
      },
    },
    webhooks: {
      verify:
        overrides.verify ??
        ((options) => JSON.parse(options.payload) as unknown),
    },
  };
  const handlers: ResendWebhookHandlers = {
    onIncomingEmail: async (email) => {
      incoming.push(email);
      await overrides.onIncomingEmail?.(email);
    },
    onDeliveryEvent: async (event) => {
      deliveries.push(event);
      await overrides.onDeliveryEvent?.(event);
    },
  };

  return {
    adapter: new ResendEmailAdapter({
      client,
      webhookSecret,
      eventDeduplicator: overrides.deduplicator ?? new TestEventDeduplicator(),
      handlers,
    }),
    incoming,
    deliveries,
    client,
  };
}

test("verifies signed webhooks with the official Resend SDK against the raw payload", async () => {
  const sdk = new Resend("re_test_key");
  const adapter = createAdapter({
    verify: (options) => sdk.webhooks.verify(options),
  }).adapter;
  const payload = receivedPayload();

  assert.deepEqual(
    await adapter.handleWebhook(payload, signPayload(payload)),
    { kind: "processed", providerEventId: "msg_test_123" },
  );
});

test("rejects invalid signatures and missing Svix headers before processing", async () => {
  const sdk = new Resend("re_test_key");
  const { adapter, incoming } = createAdapter({
    verify: (options) => sdk.webhooks.verify(options),
  });
  const payload = receivedPayload();
  const headers = signPayload(payload);

  await assert.rejects(
    adapter.handleWebhook(payload, {
      ...headers,
      "svix-signature": "v1,invalid",
    }),
    ResendWebhookAuthenticationError,
  );
  await assert.rejects(
    adapter.handleWebhook(payload, { "svix-id": headers["svix-id"] }),
    ResendWebhookAuthenticationError,
  );
  assert.equal(incoming.length, 0);
});

test("fetches inbound body from Resend and parses the received email", async () => {
  let requestedEmailId = "";
  const { adapter, incoming } = createAdapter({
    getReceived: async (id) => {
      requestedEmailId = id;
      return receivedEmailResponse(id);
    },
  });
  const payload = receivedPayload();

  await adapter.handleWebhook(payload, signPayload(payload));

  assert.equal(requestedEmailId, "received_123");
  assert.deepEqual(incoming[0], {
    providerEmailId: "received_123",
    providerMessageId: "<source-message@example.test>",
    from: "customer@example.test",
    to: ["support@example.test"],
    cc: [],
    bcc: [],
    receivedFor: ["support@example.test"],
    subject: "Help needed",
    text: "Help",
    html: "<p>Help</p>",
    receivedAt: new Date("2026-10-18T04:59:00.000Z"),
    attachments: [],
  });
});

test("deduplicates repeated webhook IDs and supports concurrent duplicate deliveries", async () => {
  const { adapter, incoming } = createAdapter();
  const payload = receivedPayload();
  const headers = signPayload(payload, "msg_duplicate");

  const results = await Promise.all([
    adapter.handleWebhook(payload, headers),
    adapter.handleWebhook(payload, headers),
  ]);

  assert.equal(incoming.length, 1);
  assert.deepEqual(results.map((result) => result.kind).sort(), [
    "duplicate",
    "processed",
  ]);
});

test("retries processing after the inbound body fetch fails", async () => {
  let fetchCount = 0;
  const { adapter, incoming } = createAdapter({
    getReceived: async (id) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        throw new TypeError("network error");
      }
      return receivedEmailResponse(id);
    },
  });
  const payload = receivedPayload();
  const headers = signPayload(payload, "msg_retry");

  await assert.rejects(
    adapter.handleWebhook(payload, headers),
    ResendTransportError,
  );
  assert.deepEqual(await adapter.handleWebhook(payload, headers), {
    kind: "processed",
    providerEventId: "msg_retry",
  });
  assert.equal(incoming.length, 1);
});

test("processes delivery events and deduplicates them by Resend webhook ID", async () => {
  const { adapter, deliveries } = createAdapter();
  const payload = deliveryPayload("email.bounced");
  const headers = signPayload(payload, "msg_bounce");

  assert.deepEqual(await adapter.handleWebhook(payload, headers), {
    kind: "processed",
    providerEventId: "msg_bounce",
  });
  assert.deepEqual(deliveries[0], {
    providerEventId: "msg_bounce",
    type: "email.bounced",
    createdAt: new Date("2026-10-18T05:00:00.000Z"),
    providerEmailId: "sent_123",
    providerMessageId: "<sent-message@example.test>",
    from: "support@example.test",
    to: ["customer@example.test"],
    subject: "Your request",
  });
});

test("ignores verified event types that are outside the adapter contract", async () => {
  const { adapter, deliveries, incoming } = createAdapter();
  const payload = JSON.stringify({
    type: "contact.created",
    created_at: "2026-10-18T05:00:00.000Z",
    data: {},
  });

  assert.deepEqual(
    await adapter.handleWebhook(payload, signPayload(payload, "msg_ignored")),
    {
      kind: "ignored",
      providerEventId: "msg_ignored",
      reason: "unsupported_event",
    },
  );
  assert.equal(deliveries.length, 0);
  assert.equal(incoming.length, 0);
});

test("rejects malformed verified events and malformed received-email API responses", async () => {
  const malformed = JSON.stringify({
    type: "email.received",
    created_at: "not-a-date",
    data: {},
  });
  const adapter = createAdapter().adapter;
  await assert.rejects(
    adapter.handleWebhook(malformed, signPayload(malformed)),
    ResendWebhookPayloadError,
  );

  const malformedApiAdapter = createAdapter({
    getReceived: async () =>
      receivedEmailResponse("different_email_id"),
  }).adapter;
  const validPayload = receivedPayload();
  await assert.rejects(
    malformedApiAdapter.handleWebhook(validPayload, signPayload(validPayload)),
    ResendProtocolError,
  );
});

test("sends outgoing email using Resend request fields and returns its provider ID", async () => {
  let sent: unknown;
  const { adapter } = createAdapter({
    send: async (options) => {
      sent = options;
      return success({ id: "sent_456" });
    },
  });

  assert.deepEqual(
    await adapter.sendEmail({
      from: "support@example.test",
      to: "customer@example.test",
      replyTo: "help@example.test",
      subject: "Your request",
      text: "We received your message.",
      html: "<p>We received your message.</p>",
    }),
    { providerEmailId: "sent_456" },
  );
  assert.deepEqual(sent, {
    from: "support@example.test",
    to: "customer@example.test",
    replyTo: "help@example.test",
    subject: "Your request",
    text: "We received your message.",
    html: "<p>We received your message.</p>",
  });
});

test("surfaces Resend API errors and reports transport errors safely", async () => {
  const apiErrorAdapter = createAdapter({
    send: async () => apiError(),
  }).adapter;
  await assert.rejects(apiErrorAdapter.sendEmail({
    from: "support@example.test",
    to: "customer@example.test",
    subject: "Test",
    text: "Body",
  }), (error: Error) => {
    assert.ok(error instanceof ResendApiError);
    assert.equal(error.statusCode, 422);
    assert.equal(error.message.includes("provider rejected request"), false);
    return true;
  });

  const transportAdapter = createAdapter({
    send: async () => {
      throw new TypeError("network failure");
    },
  }).adapter;
  await assert.rejects(transportAdapter.sendEmail({
    from: "support@example.test",
    to: "customer@example.test",
    subject: "Test",
    text: "Body",
  }), ResendTransportError);
});

test("rejects invalid outgoing email arguments before making provider calls", async () => {
  let calls = 0;
  const { adapter } = createAdapter({
    send: async () => {
      calls += 1;
      return success({ id: "sent_789" });
    },
  });

  await assert.rejects(adapter.sendEmail({
    from: " ",
    to: "customer@example.test",
    subject: "Test",
    text: "Body",
  }), TypeError);
  await assert.rejects(adapter.sendEmail({
    from: "support@example.test",
    to: [""],
    subject: "Test",
    html: "<p>Body</p>",
  }), TypeError);
  assert.equal(calls, 0);
});

test("loads credentials from explicit environment values and rejects missing secrets", () => {
  const handlers: ResendWebhookHandlers = {
    onIncomingEmail: async () => {},
    onDeliveryEvent: async () => {},
  };
  const dependencies = {
    eventDeduplicator: new TestEventDeduplicator(),
    handlers,
  };

  assert.throws(
    () =>
      createResendEmailAdapterFromEnvironment(
        { RESEND_WEBHOOK_SECRET: webhookSecret },
        dependencies,
      ),
    /RESEND_API_KEY is required/,
  );
  assert.throws(
    () =>
      createResendEmailAdapterFromEnvironment(
        {
          RESEND_API_KEY: "re_test_key",
          RESEND_FROM_EMAIL: "support@example.test",
        },
        dependencies,
      ),
    /RESEND_WEBHOOK_SECRET is required/,
  );
  assert.throws(
    () =>
      createResendEmailAdapterFromEnvironment(
        {
          RESEND_API_KEY: "re_test_key",
          RESEND_WEBHOOK_SECRET: webhookSecret,
        },
        dependencies,
      ),
    /RESEND_FROM_EMAIL is required/,
  );
  assert.doesNotThrow(() =>
    createResendEmailAdapterFromEnvironment(
      {
        RESEND_API_KEY: "re_test_key",
        RESEND_WEBHOOK_SECRET: webhookSecret,
        RESEND_FROM_EMAIL: "support@example.test",
      },
      dependencies,
    ),
  );
});

test("uses RESEND_FROM_EMAIL as the default outbound sender", async () => {
  let sent: unknown;
  const adapter = new ResendEmailAdapter({
    client: {
      emails: {
        send: async (options) => {
          sent = options;
          return success({ id: "sent_from_env" });
        },
        receiving: { get: async (id) => receivedEmailResponse(id) },
      },
      webhooks: { verify: (options) => JSON.parse(options.payload) as unknown },
    },
    webhookSecret,
    defaultFrom: "support@example.test",
    eventDeduplicator: new TestEventDeduplicator(),
    handlers: {
      onIncomingEmail: async () => {},
      onDeliveryEvent: async () => {},
    },
  });

  await adapter.sendEmail({
    to: "customer@example.test",
    subject: "Configured sender",
    text: "Test",
  });
  assert.deepEqual(sent, {
    from: "support@example.test",
    to: "customer@example.test",
    subject: "Configured sender",
    text: "Test",
  });
});
