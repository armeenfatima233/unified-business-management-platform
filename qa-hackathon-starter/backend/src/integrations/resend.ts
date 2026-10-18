import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import {
  createResendSdkClient,
  ResendEmailAdapter,
  ResendWebhookAuthenticationError,
  ResendWebhookPayloadError,
  type ResendSdkClient,
} from "../../../integrations/resend/resend-email-adapter.ts";
import {
  ResendEscalationAlertAdapter,
  type EscalationAlertFailure,
} from "../../../integrations/resend/escalation-alert-adapter.ts";
import type {
  EmailDeliveryEvent,
  IncomingEmail,
  ResendWebhookEventDeduplicator,
  ResendWebhookHandlers,
} from "../../../integrations/resend/types.ts";
import { findOrCreateContact } from "../crm/contactService.ts";
import {
  connectionConfig,
  connectionSecrets,
  findByWebhookKey,
  getConnection,
  logEvent,
  markFailure,
  markSuccess,
  processOnce,
  type Connection,
  type IntegrationContext,
} from "./core.ts";
import { tx } from "../db.ts";
import { createLead } from "../leads/service.ts";
import { apiError } from "../middleware/requireAuth.ts";

type ResendAdapter = Pick<ResendEmailAdapter, "handleWebhook" | "sendEmail">;
type ResendClientFactory = (apiKey: string) => ResendSdkClient;

interface ResendConnectionSecrets {
  apiKey?: string;
  webhookSecret?: string;
}

interface ResendConnectionConfig {
  fromEmail?: string;
  inboundAddress?: string;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function configuredSecrets(
  ctx: IntegrationContext,
  connection: Connection,
): ResendConnectionSecrets {
  return connectionSecrets<ResendConnectionSecrets>(ctx, connection);
}

function createAdapter(
  ctx: IntegrationContext,
  connection: Connection,
  clientFactory: ResendClientFactory,
  handlers: ResendWebhookHandlers,
  eventDeduplicator: ResendWebhookEventDeduplicator,
): ResendAdapter {
  const secrets = configuredSecrets(ctx, connection);
  const config =
    connectionConfig<ResendConnectionConfig>(connection);
  if (!secrets.apiKey || !secrets.webhookSecret) {
    throw new Error("Resend connection credentials are incomplete");
  }

  return new ResendEmailAdapter({
    client: clientFactory(secrets.apiKey),
    webhookSecret: secrets.webhookSecret,
    defaultFrom: config.fromEmail,
    eventDeduplicator,
    handlers,
  });
}

function databaseDeduplicator(
  ctx: IntegrationContext,
  workspaceId: string,
): ResendWebhookEventDeduplicator {
  return {
    async processOnce(providerEventId, work) {
      return processOnce(
        ctx.db,
        workspaceId,
        "resend",
        providerEventId,
        () => {
          const result = work();
          if (isPromiseLike(result)) {
            throw new TypeError(
              "Resend CRM webhook handlers must complete synchronously inside the database transaction",
            );
          }
        },
      );
    },
  };
}

function parseSender(value: string): { email: string; name: string } {
  const trimmed = value.trim();
  const angleAddress = /^(.*?)<([^<>]+)>$/.exec(trimmed);
  const email = (angleAddress?.[2] ?? trimmed).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TypeError("Resend inbound sender address is invalid");
  }
  const displayName = angleAddress?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  return {
    email,
    name: displayName || email.slice(0, email.indexOf("@")),
  };
}

function handleIncomingEmail(
  ctx: IntegrationContext,
  connection: Connection,
  email: IncomingEmail,
): void {
  const config =
    connectionConfig<ResendConnectionConfig>(connection);
  if (config.inboundAddress) {
    const expected = config.inboundAddress.trim().toLowerCase();
    const actualRecipients = [...email.receivedFor, ...email.to].map((address) =>
      address.trim().toLowerCase(),
    );
    if (!actualRecipients.includes(expected)) {
      throw new TypeError("Resend email was addressed to an unconfigured inbox");
    }
  }

  const sender = parseSender(email.from);
  const messageBody = email.text ?? email.html ?? "";
  const storedBody = email.subject
    ? `${email.subject}\n\n${messageBody}`
    : messageBody;

  tx(ctx.db, () => {
    const contact = findOrCreateContact(
      ctx.db,
      connection.workspace_id,
      { name: sender.name, email: sender.email },
      null,
    );
    let conversation = ctx.db
      .prepare(
        "SELECT id FROM conversations WHERE workspace_id = ? AND contact_id = ? AND channel = 'email'",
      )
      .get(connection.workspace_id, contact.id) as { id: string } | undefined;
    if (!conversation) {
      const conversationId = randomUUID();
      ctx.db
        .prepare(
          "INSERT INTO conversations (id, workspace_id, contact_id, channel, last_message_at, unread) VALUES (?,?,?,'email',?,0)",
        )
        .run(
          conversationId,
          connection.workspace_id,
          contact.id,
          email.receivedAt.toISOString(),
        );
      conversation = { id: conversationId };
    }

    const inserted = ctx.db
      .prepare(
        `INSERT OR IGNORE INTO messages
          (id, workspace_id, conversation_id, direction, body, provider_message_id, status, created_at)
         VALUES (?,?,?,'inbound',?,?,'received',?)`,
      )
      .run(
        randomUUID(),
        connection.workspace_id,
        conversation.id,
        storedBody,
        email.providerMessageId,
        email.receivedAt.toISOString(),
      );
    if (inserted.changes === 0) return;

    ctx.db
      .prepare(
        "UPDATE conversations SET last_message_at = ?, unread = unread + 1 WHERE workspace_id = ? AND id = ?",
      )
      .run(
        email.receivedAt.toISOString(),
        connection.workspace_id,
        conversation.id,
      );
    createLead(ctx.db, {
      workspaceId: connection.workspace_id,
      contactId: contact.id,
      source: "message",
      message: storedBody,
      actorId: null,
    });
    markSuccess(ctx.db, connection);
    logEvent(ctx.db, {
      workspaceId: connection.workspace_id,
      provider: "resend",
      direction: "inbound",
      eventType: "email.received",
      externalId: email.providerEmailId,
      result: "ok",
    });
  });
}

function handleDeliveryEvent(
  ctx: IntegrationContext,
  connection: Connection,
  event: EmailDeliveryEvent,
): void {
  const statusByType: Partial<
    Record<EmailDeliveryEvent["type"], "sent" | "delivered" | "queued" | "failed">
  > = {
    "email.sent": "sent",
    "email.delivered": "delivered",
    "email.delivery_delayed": "queued",
    "email.bounced": "failed",
    "email.complained": "failed",
    "email.failed": "failed",
    "email.suppressed": "failed",
  };
  const status = statusByType[event.type];
  if (status) {
    ctx.db
      .prepare(
        `UPDATE messages
         SET status = ?, failure_reason = ?
         WHERE workspace_id = ? AND direction = 'outbound' AND provider_message_id = ?`,
      )
      .run(
        status,
        status === "failed" ? event.type : null,
        connection.workspace_id,
        event.providerEmailId,
      );
  }
  markSuccess(ctx.db, connection);
  logEvent(ctx.db, {
    workspaceId: connection.workspace_id,
    provider: "resend",
    direction: "inbound",
    eventType: event.type,
    externalId: event.providerEmailId,
    result: "ok",
  });
}

function rawRequestBody(req: Request): Buffer | undefined {
  return req.rawBody;
}

export function resendWebhookRouter(
  ctx: IntegrationContext,
  clientFactory: ResendClientFactory = createResendSdkClient,
) {
  const router = Router();
  router.post("/:webhookKey", async (req, res) => {
    const webhookKey = String(req.params.webhookKey);
    const connection = findByWebhookKey(ctx.db, "resend", webhookKey);
    if (!connection || connection.status !== "connected") {
      return apiError(res, 404, "NOT_FOUND", "Webhook endpoint not found.");
    }
    const body = rawRequestBody(req);
    if (!body) {
      return apiError(res, 400, "INVALID_WEBHOOK", "Webhook body is unavailable.");
    }
    try {
      const adapter = createAdapter(
        ctx,
        connection,
        clientFactory,
        {
          onIncomingEmail: (email) =>
            handleIncomingEmail(ctx, connection, email),
          onDeliveryEvent: (event) =>
            handleDeliveryEvent(ctx, connection, event),
        },
        databaseDeduplicator(ctx, connection.workspace_id),
      );
      const result = await adapter.handleWebhook(body.toString("utf8"), {
        "svix-id": req.header("svix-id"),
        "svix-timestamp": req.header("svix-timestamp"),
        "svix-signature": req.header("svix-signature"),
      });
      if (result.kind === "duplicate") {
        logEvent(ctx.db, {
          workspaceId: connection.workspace_id,
          provider: "resend",
          direction: "inbound",
          eventType: "webhook",
          externalId: result.providerEventId,
          result: "duplicate",
        });
      }
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof ResendWebhookAuthenticationError) {
        return apiError(res, 401, "INVALID_SIGNATURE", "Webhook signature is invalid.");
      }
      if (error instanceof ResendWebhookPayloadError) {
        return apiError(res, 400, "INVALID_WEBHOOK", "Webhook payload is invalid.");
      }
      console.error("Resend webhook processing failed", {
        connectionId: connection.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return apiError(res, 500, "WEBHOOK_PROCESSING_FAILED", "Webhook processing failed.");
    }
  });
  return router;
}

function failureRecorder(
  ctx: IntegrationContext,
): { recordFailure(failure: EscalationAlertFailure): Promise<void> } {
  return {
    async recordFailure(failure) {
      const nextAttemptAt = failure.finalAttempt
        ? null
        : new Date(Date.now() + (failure.attempt === 1 ? 250 : 1000)).toISOString();
      ctx.db
        .prepare(
          `UPDATE delivery_attempts
           SET attempts = MAX(attempts, ?), last_error = ?, status = ?, next_attempt_at = ?
           WHERE id = ? AND workspace_id = ?`,
        )
        .run(
          failure.attempt,
          failure.errorName,
          failure.finalAttempt ? "failed" : "pending",
          nextAttemptAt,
          failure.alertId,
          failure.workspaceId,
        );
      logEvent(ctx.db, {
        workspaceId: failure.workspaceId,
        provider: "resend",
        direction: "outbound",
        eventType: "escalation_alert",
        externalId: failure.alertId,
        result: "error",
        detail: `${failure.errorName}; attempt ${failure.attempt}`,
      });
    },
  };
}

function escalationAdapter(
  ctx: IntegrationContext,
  connection: Connection,
  clientFactory: ResendClientFactory,
) {
  const alertAdapter = createAdapter(
    ctx,
    connection,
    clientFactory,
    { onIncomingEmail: () => undefined, onDeliveryEvent: () => undefined },
    { processOnce: async (_eventId, work) => { await work(); return true; } },
  );
  return new ResendEscalationAlertAdapter({
    sender: alertAdapter,
    recipientResolver: {
      async resolveRecipient(workspaceId, employeeId) {
        const row = ctx.db
          .prepare(
            "SELECT destination FROM notification_destinations WHERE workspace_id = ? AND user_id = ? AND channel = 'email'",
          )
          .get(workspaceId, employeeId) as { destination: string } | undefined;
        return row ? { email: row.destination } : null;
      },
    },
    failureRecorder: failureRecorder(ctx),
  });
}

export async function dispatchResendEscalationAlerts(
  ctx: IntegrationContext,
  clientFactory: ResendClientFactory = createResendSdkClient,
): Promise<void> {
  const now = new Date().toISOString();
  const pending = ctx.db
    .prepare(
      `SELECT d.id, d.workspace_id, d.user_id, d.lead_id, d.reason, d.attempts,
              c.name AS lead_name, l.source AS lead_source
       FROM delivery_attempts d
       JOIN leads l ON l.workspace_id = d.workspace_id AND l.id = d.lead_id
       JOIN contacts c ON c.workspace_id = l.workspace_id AND c.id = l.contact_id
       WHERE d.channel = 'email' AND d.status = 'pending' AND d.attempts < 3
         AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
       ORDER BY d.created_at LIMIT 10`,
    )
    .all(now) as {
    id: string;
    workspace_id: string;
    user_id: string;
    lead_id: string;
    reason: string | null;
    attempts: number;
    lead_name: string;
    lead_source: string;
  }[];

  for (const item of pending) {
    const connection = getConnection(
      ctx.db,
      item.workspace_id,
      "resend",
    );
    if (!connection || connection.status !== "connected") {
      const message = "Resend is not connected for this workspace";
      ctx.db
        .prepare(
          "UPDATE delivery_attempts SET status = 'failed', last_error = ?, next_attempt_at = NULL WHERE id = ?",
        )
        .run(message, item.id);
      continue;
    }
    try {
      const base = new URL(ctx.frontendUrl);
      if (base.protocol !== "https:") {
        throw new TypeError("The escalation link requires an HTTPS frontend URL");
      }
      const directLink = new URL(
        `/leads/${encodeURIComponent(item.lead_id)}`,
        base,
      ).toString();
      const adapter = escalationAdapter(ctx, connection, clientFactory);
      const receipt = await adapter.sendEscalationAlert({
        alertId: item.id,
        previousAttempts: item.attempts,
        workspaceId: item.workspace_id,
        employeeId: item.user_id,
        leadId: item.lead_id,
        leadName: item.lead_name,
        leadSource: item.lead_source,
        reason: item.reason ?? "Lead escalated",
        directLink,
      });
      ctx.db
        .prepare(
          "UPDATE delivery_attempts SET status = 'sent', attempts = ?, last_error = NULL, next_attempt_at = NULL WHERE id = ?",
        )
        .run(receipt.attempts, item.id);
      markSuccess(ctx.db, connection);
      logEvent(ctx.db, {
        workspaceId: item.workspace_id,
        provider: "resend",
        direction: "outbound",
        eventType: "escalation_alert",
        externalId: receipt.providerEmailId,
        result: "ok",
      });
    } catch (error) {
      markFailure(
        ctx.db,
        connection,
        error instanceof Error ? error.name : "UnknownError",
      );
      ctx.db
        .prepare(
          "UPDATE delivery_attempts SET status = 'failed', last_error = COALESCE(last_error, ?), next_attempt_at = NULL WHERE id = ? AND status = 'pending'",
        )
        .run(
          error instanceof Error ? error.name : "UnknownError",
          item.id,
        );
      console.error("Resend escalation alert failed", {
        alertId: item.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}

export function mountResendIntegration(
  app: import("express").Express,
  ctx: IntegrationContext,
  clientFactory?: ResendClientFactory,
): void {
  app.use(
    "/api/v1/webhooks/resend",
    resendWebhookRouter(ctx, clientFactory),
  );
}
