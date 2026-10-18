import { createHash } from "node:crypto";
import {
  ResendApiError,
  ResendTransportError,
  type ResendEmailAdapter,
} from "./resend-email-adapter.ts";
import type { OutgoingEmailReceipt } from "./types.ts";

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 1000];

export interface EscalationAlertInput {
  alertId: string;
  previousAttempts?: number;
  workspaceId: string;
  employeeId: string;
  leadId: string;
  leadName: string;
  leadSource: string;
  reason: string;
  directLink: string;
}

export interface EscalationAlertRecipient {
  email: string;
}

export interface EscalationAlertRecipientResolver {
  /**
   * Resolve the employee-configured recipient using backend-owned,
   * workspace-scoped settings.
   */
  resolveRecipient(
    workspaceId: string,
    employeeId: string,
  ): Promise<EscalationAlertRecipient | null>;
}

export interface EscalationAlertFailure {
  alertId: string;
  workspaceId: string;
  employeeId: string;
  leadId: string;
  attempt: number;
  occurredAt: Date;
  errorName: string;
  providerStatusCode: number | null;
  retryable: boolean;
  finalAttempt: boolean;
}

export interface EscalationAlertFailureRecorder {
  /** Backend persists the failure for integration status/history and retries. */
  recordFailure(failure: EscalationAlertFailure): Promise<void>;
}

export interface EscalationAlertReceipt extends OutgoingEmailReceipt {
  attempts: number;
}

export interface EscalationAlertAdapterOptions {
  sender: Pick<ResendEmailAdapter, "sendEmail">;
  recipientResolver: EscalationAlertRecipientResolver;
  failureRecorder: EscalationAlertFailureRecorder;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

export class EscalationAlertRecipientError extends Error {
  constructor() {
    super("No valid escalation alert recipient is configured for this employee");
    this.name = "EscalationAlertRecipientError";
  }
}

export class EscalationAlertDeliveryError extends Error {
  readonly attempts: number;
  readonly providerErrorName: string;

  constructor(attempts: number, providerErrorName: string) {
    super("Resend could not deliver the escalation alert");
    this.name = "EscalationAlertDeliveryError";
    this.attempts = attempts;
    this.providerErrorName = providerErrorName;
  }
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateAlert(alert: EscalationAlertInput): URL {
  if (
    !alert.alertId.trim() ||
    !alert.workspaceId.trim() ||
    !alert.employeeId.trim() ||
    !alert.leadId.trim() ||
    !alert.leadName.trim() ||
    !alert.leadSource.trim() ||
    !alert.reason.trim()
  ) {
    throw new TypeError("Escalation alert context fields must not be empty");
  }
  let link: URL;
  try {
    link = new URL(alert.directLink);
  } catch {
    throw new TypeError("Escalation alert link must be an absolute HTTPS URL");
  }
  if (link.protocol !== "https:") {
    throw new TypeError("Escalation alert link must be an absolute HTTPS URL");
  }
  if (
    alert.previousAttempts !== undefined &&
    (!Number.isInteger(alert.previousAttempts) ||
      alert.previousAttempts < 0 ||
      alert.previousAttempts >= MAX_ATTEMPTS)
  ) {
    throw new TypeError("Escalation alert retry count is invalid");
  }
  return link;
}

function makeIdempotencyKey(alertId: string): string {
  return `ubmp-escalation-${createHash("sha256").update(alertId).digest("hex")}`;
}

function classifyFailure(error: unknown): {
  name: string;
  statusCode: number | null;
  retryable: boolean;
} {
  if (error instanceof ResendApiError) {
    const statusCode = error.statusCode;
    return {
      name: error.providerErrorName,
      statusCode,
      retryable:
        statusCode === 429 ||
        (statusCode !== null && statusCode >= 500 && statusCode <= 599),
    };
  }
  if (error instanceof ResendTransportError) {
    return {
      name: error.name,
      statusCode: null,
      retryable: true,
    };
  }
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    statusCode: null,
    retryable: false,
  };
}

export class ResendEscalationAlertAdapter {
  private readonly sender: Pick<ResendEmailAdapter, "sendEmail">;
  private readonly recipientResolver: EscalationAlertRecipientResolver;
  private readonly failureRecorder: EscalationAlertFailureRecorder;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(options: EscalationAlertAdapterOptions) {
    this.sender = options.sender;
    this.recipientResolver = options.recipientResolver;
    this.failureRecorder = options.failureRecorder;
    this.wait =
      options.wait ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
  }

  async sendEscalationAlert(
    alert: EscalationAlertInput,
  ): Promise<EscalationAlertReceipt> {
    const link = validateAlert(alert);
    const configuredRecipient = await this.recipientResolver.resolveRecipient(
      alert.workspaceId,
      alert.employeeId,
    );
    const recipient = configuredRecipient?.email.trim();
    if (!recipient || !isValidEmail(recipient)) {
      await this.failureRecorder.recordFailure({
        alertId: alert.alertId,
        workspaceId: alert.workspaceId,
        employeeId: alert.employeeId,
        leadId: alert.leadId,
        attempt: 0,
        occurredAt: this.now(),
        errorName: "EscalationAlertRecipientError",
        providerStatusCode: null,
        retryable: false,
        finalAttempt: true,
      });
      throw new EscalationAlertRecipientError();
    }

    const email = {
      to: recipient,
      subject: `Lead escalation: ${alert.leadName}`,
      text: [
        `Lead: ${alert.leadName}`,
        `Source: ${alert.leadSource}`,
        `Escalation reason: ${alert.reason}`,
        `View lead: ${link.toString()}`,
      ].join("\n"),
    };
    const idempotencyKey = makeIdempotencyKey(alert.alertId);

    const previousAttempts = alert.previousAttempts ?? 0;
    for (
      let attempt = previousAttempts + 1;
      attempt <= MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const receipt = await this.sender.sendEmail(email, { idempotencyKey });
        return { ...receipt, attempts: attempt };
      } catch (error) {
        const failure = classifyFailure(error);
        const finalAttempt = !failure.retryable || attempt === MAX_ATTEMPTS;
        await this.failureRecorder.recordFailure({
          alertId: alert.alertId,
          workspaceId: alert.workspaceId,
          employeeId: alert.employeeId,
          leadId: alert.leadId,
          attempt,
          occurredAt: this.now(),
          errorName: failure.name,
          providerStatusCode: failure.statusCode,
          retryable: failure.retryable,
          finalAttempt,
        });
        if (finalAttempt) {
          throw new EscalationAlertDeliveryError(attempt, failure.name);
        }
        await this.wait(RETRY_DELAYS_MS[attempt - 1]);
      }
    }

    throw new EscalationAlertDeliveryError(MAX_ATTEMPTS, "UnknownError");
  }
}
