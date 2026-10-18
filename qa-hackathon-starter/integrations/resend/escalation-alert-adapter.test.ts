import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreateEmailOptions,
  CreateEmailRequestOptions,
} from "resend";
import {
  ResendApiError,
  ResendEmailAdapter,
  ResendTransportError,
  type ResendSdkClient,
} from "./resend-email-adapter.ts";
import {
  EscalationAlertDeliveryError,
  EscalationAlertRecipientError,
  ResendEscalationAlertAdapter,
  type EscalationAlertFailure,
  type EscalationAlertInput,
} from "./escalation-alert-adapter.ts";
import type {
  ResendWebhookEventDeduplicator,
  ResendWebhookHandlers,
} from "./types.ts";

const alert: EscalationAlertInput = {
  alertId: "escalation_123",
  workspaceId: "workspace_1",
  employeeId: "employee_1",
  leadId: "lead_1",
  leadName: "Avery Smith",
  leadSource: "Website",
  reason: "Acknowledgement deadline expired",
  directLink: "https://app.example.test/leads/lead_1",
};

class TestDeduplicator implements ResendWebhookEventDeduplicator {
  async processOnce(
    _providerEventId: string,
    work: () => Promise<void>,
  ): Promise<boolean> {
    await work();
    return true;
  }
}

function createResendSender(
  send: ResendSdkClient["emails"]["send"],
): ResendEmailAdapter {
  const client: ResendSdkClient = {
    emails: {
      send,
      receiving: {
        get: async () => ({
          data: null,
          error: { name: "not_found", statusCode: 404, message: "not found" },
          headers: null,
        }),
      },
    },
    webhooks: { verify: () => ({}) },
  };
  const handlers: ResendWebhookHandlers = {
    onIncomingEmail: async () => {},
    onDeliveryEvent: async () => {},
  };
  return new ResendEmailAdapter({
    client,
    webhookSecret: "test-webhook-secret",
    eventDeduplicator: new TestDeduplicator(),
    handlers,
    defaultFrom: "alerts@example.test",
  });
}

function setup(options: {
  recipient?: string | null;
  onSend?: (
    email: CreateEmailOptions,
    requestOptions?: CreateEmailRequestOptions,
  ) => Promise<{ providerEmailId: string }>;
} = {}) {
  const sent: Array<{
    email: CreateEmailOptions;
    requestOptions?: CreateEmailRequestOptions;
  }> = [];
  const failures: EscalationAlertFailure[] = [];
  const waits: number[] = [];
  const sender = createResendSender(async (email, requestOptions) => {
    sent.push({ email, requestOptions });
    const receipt = await options.onSend?.(email, requestOptions);
    return {
      data: { id: receipt?.providerEmailId ?? "resend_message_1" },
      error: null,
      headers: null,
    };
  });
  const adapter = new ResendEscalationAlertAdapter({
    sender,
    recipientResolver: {
      resolveRecipient: async (workspaceId, employeeId) => {
        assert.equal(workspaceId, alert.workspaceId);
        assert.equal(employeeId, alert.employeeId);
        return options.recipient === null
          ? null
          : { email: options.recipient ?? "employee@example.test" };
      },
    },
    failureRecorder: {
      recordFailure: async (failure) => {
        failures.push(failure);
      },
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
    now: () => new Date("2026-10-18T12:00:00.000Z"),
  });
  return { adapter, sent, failures, waits };
}

test("sends contextual escalation email to employee-configured address", async () => {
  const { adapter, sent, failures } = setup();
  assert.deepEqual(await adapter.sendEscalationAlert(alert), {
    providerEmailId: "resend_message_1",
    attempts: 1,
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].email, {
    from: "alerts@example.test",
    to: "employee@example.test",
    subject: "Lead escalation: Avery Smith",
    text: [
      "Lead: Avery Smith",
      "Source: Website",
      "Escalation reason: Acknowledgement deadline expired",
      "View lead: https://app.example.test/leads/lead_1",
    ].join("\n"),
  });
  assert.match(
    sent[0].requestOptions?.idempotencyKey ?? "",
    /^ubmp-escalation-[a-f0-9]{64}$/,
  );
  assert.deepEqual(failures, []);
});

test("rejects invalid or missing employee recipients and records configuration failure", async () => {
  for (const recipient of ["not-an-email", null]) {
    const { adapter, sent, failures } = setup({ recipient });
    await assert.rejects(
      adapter.sendEscalationAlert(alert),
      EscalationAlertRecipientError,
    );
    assert.equal(sent.length, 0);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].attempt, 0);
    assert.equal(failures[0].retryable, false);
    assert.equal(failures[0].finalAttempt, true);
  }
});

test("retries transient transport failures with bounded backoff and stable idempotency key", async () => {
  let providerCalls = 0;
  const { adapter, failures, sent, waits } = setup({
    onSend: async (_email, requestOptions) => {
      providerCalls += 1;
      if (providerCalls < 3) {
        throw new ResendTransportError();
      }
      assert.equal(
        requestOptions?.idempotencyKey,
        sent[0].requestOptions?.idempotencyKey,
      );
      return { providerEmailId: "accepted_after_retry" };
    },
  });

  assert.deepEqual(await adapter.sendEscalationAlert(alert), {
    providerEmailId: "accepted_after_retry",
    attempts: 3,
  });
  assert.equal(sent.length, 3);
  assert.deepEqual(waits, [250, 1000]);
  assert.deepEqual(
    failures.map(({ attempt, retryable, finalAttempt }) => ({
      attempt,
      retryable,
      finalAttempt,
    })),
    [
      { attempt: 1, retryable: true, finalAttempt: false },
      { attempt: 2, retryable: true, finalAttempt: false },
    ],
  );
});

test("retries provider 5xx errors but does not retry permanent provider errors", async () => {
  let calls = 0;
  const transient = setup({
    onSend: async () => {
      calls += 1;
      if (calls === 1) {
        throw new ResendApiError("internal_server_error", 503);
      }
      return { providerEmailId: "accepted" };
    },
  });
  assert.deepEqual(await transient.adapter.sendEscalationAlert(alert), {
    providerEmailId: "accepted",
    attempts: 2,
  });
  assert.equal(transient.failures[0].providerStatusCode, 503);

  let invalidCalls = 0;
  const permanent = setup({
    onSend: async () => {
      invalidCalls += 1;
      throw new ResendApiError("invalid_from_address", 422);
    },
  });
  await assert.rejects(
    permanent.adapter.sendEscalationAlert(alert),
    (error: Error) => {
      assert.ok(error instanceof EscalationAlertDeliveryError);
      assert.equal(error.attempts, 1);
      assert.equal(error.providerErrorName, "invalid_from_address");
      return true;
    },
  );
  assert.equal(invalidCalls, 1);
  assert.equal(permanent.failures.length, 1);
  assert.equal(permanent.failures[0].retryable, false);
  assert.equal(permanent.failures[0].finalAttempt, true);
});

test("records final failure after exhausting the retry limit", async () => {
  const { adapter, failures, sent, waits } = setup({
    onSend: async () => {
      throw new ResendApiError("rate_limit_exceeded", 429);
    },
  });
  await assert.rejects(adapter.sendEscalationAlert(alert), (error: Error) => {
    assert.ok(error instanceof EscalationAlertDeliveryError);
    assert.equal(error.attempts, 3);
    return true;
  });
  assert.equal(sent.length, 3);
  assert.equal(failures.length, 3);
  assert.equal(failures[2].finalAttempt, true);
  assert.deepEqual(waits, [250, 1000]);
});

test("requires an HTTPS direct link and does not attempt a send for invalid context", async () => {
  const { adapter, sent } = setup();
  await assert.rejects(
    adapter.sendEscalationAlert({ ...alert, directLink: "http://app.test/lead" }),
    TypeError,
  );
  assert.equal(sent.length, 0);
});
