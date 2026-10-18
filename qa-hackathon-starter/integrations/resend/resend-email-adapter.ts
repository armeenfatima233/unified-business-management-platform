import {
  Resend,
  type CreateEmailOptions,
  type CreateEmailRequestOptions,
  type CreateEmailResponse,
  type GetReceivingEmailResponse,
} from "resend";
import type {
  EmailDeliveryEvent,
  EmailDeliveryEventType,
  IncomingEmail,
  OutgoingEmail,
  OutgoingEmailReceipt,
  ResendWebhookEventDeduplicator,
  ResendWebhookHeaders,
  ResendWebhookHandlers,
  ResendWebhookResult,
} from "./types.ts";

type SendEmailMethod = (
  options: CreateEmailOptions,
  requestOptions?: CreateEmailRequestOptions,
) => Promise<CreateEmailResponse>;
type GetReceivingEmailMethod = (
  id: string,
) => Promise<GetReceivingEmailResponse>;
type VerifyWebhookMethod = (
  options: Parameters<Resend["webhooks"]["verify"]>[0],
) => unknown;

export interface ResendSdkClient {
  emails: {
    send: SendEmailMethod;
    receiving: {
      get: GetReceivingEmailMethod;
    };
  };
  webhooks: {
    verify: VerifyWebhookMethod;
  };
}

export class ResendApiError extends Error {
  readonly providerErrorName: string;
  readonly statusCode: number | null;

  constructor(providerErrorName: string, statusCode: number | null) {
    super("Resend rejected the email API request");
    this.name = "ResendApiError";
    this.providerErrorName = providerErrorName;
    this.statusCode = statusCode;
  }
}

export class ResendTransportError extends Error {
  constructor() {
    super("The Resend API request could not be completed");
    this.name = "ResendTransportError";
  }
}

export class ResendProtocolError extends Error {
  constructor() {
    super("Resend returned an invalid API response");
    this.name = "ResendProtocolError";
  }
}

export class ResendWebhookAuthenticationError extends Error {
  constructor() {
    super("Resend webhook authenticity could not be verified");
    this.name = "ResendWebhookAuthenticationError";
  }
}

export class ResendWebhookPayloadError extends Error {
  constructor() {
    super("Resend webhook payload is malformed");
    this.name = "ResendWebhookPayloadError";
  }
}

interface ResendEmailAdapterOptions {
  client: ResendSdkClient;
  webhookSecret: string;
  eventDeduplicator: ResendWebhookEventDeduplicator;
  handlers: ResendWebhookHandlers;
  defaultFrom?: string;
}

type ResolvedOutgoingEmail = {
  from: string;
  to: string | string[];
  subject: string;
  replyTo?: string | string[];
} & (
  | { text: string; html?: string }
  | { html: string; text?: string }
);

interface ParsedReceivedEvent {
  kind: "received";
  providerEmailId: string;
  providerMessageId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  receivedFor: string[];
  subject: string;
  receivedAt: Date;
}

interface ParsedDeliveryEvent {
  kind: "delivery";
  event: Omit<EmailDeliveryEvent, "providerEventId">;
}

type ParsedWebhookEvent =
  | ParsedReceivedEvent
  | ParsedDeliveryEvent
  | { kind: "unsupported" };

const DELIVERY_EVENT_TYPES = new Set<string>([
  "email.sent",
  "email.scheduled",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.suppressed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ResendWebhookPayloadError();
  }
  return value;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new ResendWebhookPayloadError();
  }
  return value;
}

function requireDate(record: Record<string, unknown>, key: string): Date {
  const value = requireString(record, key);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ResendWebhookPayloadError();
  }
  return date;
}

function parseWebhookEvent(value: unknown): ParsedWebhookEvent {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new ResendWebhookPayloadError();
  }

  const eventType = requireString(value, "type");
  const data = value.data;

  if (eventType === "email.received") {
    const receivedAt = requireDate(data, "created_at");
    requireDate(value, "created_at");

    return {
      kind: "received",
      providerEmailId: requireString(data, "email_id"),
      providerMessageId: requireString(data, "message_id"),
      from: requireString(data, "from"),
      to: optionalStringArray(data, "to"),
      cc: optionalStringArray(data, "cc"),
      bcc: optionalStringArray(data, "bcc"),
      receivedFor: optionalStringArray(data, "received_for"),
      subject: typeof data.subject === "string" ? data.subject : "",
      receivedAt,
    };
  }

  if (DELIVERY_EVENT_TYPES.has(eventType)) {
    const createdAt = requireDate(value, "created_at");
    requireDate(data, "created_at");
    const event: Omit<EmailDeliveryEvent, "providerEventId"> = {
      type: eventType as EmailDeliveryEventType,
      createdAt,
      providerEmailId: requireString(data, "email_id"),
      providerMessageId: requireString(data, "message_id"),
      from: requireString(data, "from"),
      to: optionalStringArray(data, "to"),
      subject: typeof data.subject === "string" ? data.subject : "",
    };
    return { kind: "delivery", event };
  }

  return { kind: "unsupported" };
}

function parseReceivedEmail(
  emailId: string,
  value: GetReceivingEmailResponse["data"],
): IncomingEmail {
  if (
    !isRecord(value) ||
    value.id !== emailId ||
    typeof value.from !== "string" ||
    typeof value.subject !== "string" ||
    typeof value.created_at !== "string" ||
    (value.text !== null && typeof value.text !== "string") ||
    (value.html !== null && typeof value.html !== "string") ||
    typeof value.message_id !== "string" ||
    !Array.isArray(value.to) ||
    !value.to.every((item) => typeof item === "string") ||
    !Array.isArray(value.attachments)
  ) {
    throw new ResendProtocolError();
  }

  const cc = value.cc ?? [];
  const bcc = value.bcc ?? [];
  const receivedFor = value.received_for;
  if (
    !Array.isArray(cc) ||
    !cc.every((item) => typeof item === "string") ||
    !Array.isArray(bcc) ||
    !bcc.every((item) => typeof item === "string") ||
    !Array.isArray(receivedFor) ||
    !receivedFor.every((item) => typeof item === "string")
  ) {
    throw new ResendProtocolError();
  }

  const receivedAt = new Date(value.created_at);
  if (Number.isNaN(receivedAt.getTime())) {
    throw new ResendProtocolError();
  }

  const attachments = value.attachments.map((attachment) => {
    if (
      !isRecord(attachment) ||
      typeof attachment.id !== "string" ||
      (attachment.filename !== null && typeof attachment.filename !== "string") ||
      typeof attachment.content_type !== "string"
    ) {
      throw new ResendProtocolError();
    }

    return {
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.content_type,
    };
  });

  return {
    providerEmailId: value.id,
    providerMessageId: value.message_id,
    from: value.from,
    to: value.to,
    cc,
    bcc,
    receivedFor,
    subject: value.subject,
    text: value.text,
    html: value.html,
    receivedAt,
    attachments,
  };
}

function resolveOutgoingEmail(
  email: OutgoingEmail,
  defaultFrom?: string,
): ResolvedOutgoingEmail {
  const from = email.from?.trim() || defaultFrom?.trim();
  const recipients = Array.isArray(email.to) ? email.to : [email.to];
  if (
    from === undefined ||
    email.subject.trim().length === 0 ||
    recipients.length === 0 ||
    recipients.some((recipient) => recipient.trim().length === 0)
  ) {
    throw new TypeError("Email sender, subject, and recipients must not be empty");
  }

  const base = {
    from,
    to: email.to,
    subject: email.subject,
    ...(email.replyTo !== undefined ? { replyTo: email.replyTo } : {}),
  };
  if (email.text !== undefined) {
    return {
      ...base,
      text: email.text,
      ...(email.html !== undefined ? { html: email.html } : {}),
    };
  }
  if (email.html !== undefined) {
    return { ...base, html: email.html };
  }
  throw new TypeError("Email must include a text or HTML body");
}

function toCreateEmailOptions(email: ResolvedOutgoingEmail): CreateEmailOptions {
  const base = {
    from: email.from,
    to: email.to,
    subject: email.subject,
    ...(email.replyTo !== undefined ? { replyTo: email.replyTo } : {}),
  };
  if (email.text !== undefined) {
    return {
      ...base,
      text: email.text,
      ...(email.html !== undefined ? { html: email.html } : {}),
    };
  }

  if (email.html === undefined) {
    throw new TypeError("Email must include a text or HTML body");
  }

  return { ...base, html: email.html };
}

function requiredHeader(
  headers: ResendWebhookHeaders,
  name: keyof ResendWebhookHeaders,
): string {
  const value = headers[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ResendWebhookAuthenticationError();
  }
  return value;
}

export class ResendEmailAdapter {
  private readonly client: ResendSdkClient;
  private readonly webhookSecret: string;
  private readonly eventDeduplicator: ResendWebhookEventDeduplicator;
  private readonly handlers: ResendWebhookHandlers;
  private readonly defaultFrom?: string;

  constructor({
    client,
    webhookSecret,
    eventDeduplicator,
    handlers,
    defaultFrom,
  }: ResendEmailAdapterOptions) {
    if (webhookSecret.length === 0) {
      throw new TypeError("Resend webhook signing secret must not be empty");
    }

    this.client = client;
    this.webhookSecret = webhookSecret;
    this.eventDeduplicator = eventDeduplicator;
    this.handlers = handlers;
    this.defaultFrom = defaultFrom;
  }

  async sendEmail(
    email: OutgoingEmail,
    requestOptions?: CreateEmailRequestOptions,
  ): Promise<OutgoingEmailReceipt> {
    const resolvedEmail = resolveOutgoingEmail(email, this.defaultFrom);

    let response: CreateEmailResponse;
    try {
      response = await this.client.emails.send(
        toCreateEmailOptions(resolvedEmail),
        requestOptions,
      );
    } catch (error) {
      if (error instanceof TypeError) {
        throw new ResendTransportError();
      }
      throw error;
    }

    if (response.error !== null) {
      throw new ResendApiError(response.error.name, response.error.statusCode);
    }
    if (
      response.data === null ||
      typeof response.data.id !== "string" ||
      response.data.id.length === 0
    ) {
      throw new ResendProtocolError();
    }

    return { providerEmailId: response.data.id };
  }

  async handleWebhook(
    rawPayload: string,
    headers: ResendWebhookHeaders,
  ): Promise<ResendWebhookResult> {
    const providerEventId = requiredHeader(headers, "svix-id");
    const timestamp = requiredHeader(headers, "svix-timestamp");
    const signature = requiredHeader(headers, "svix-signature");

    let verifiedEvent: unknown;
    try {
      verifiedEvent = this.client.webhooks.verify({
        payload: rawPayload,
        headers: { id: providerEventId, timestamp, signature },
        webhookSecret: this.webhookSecret,
      });
    } catch {
      throw new ResendWebhookAuthenticationError();
    }

    const event = parseWebhookEvent(verifiedEvent);
    if (event.kind === "unsupported") {
      return { kind: "ignored", providerEventId, reason: "unsupported_event" };
    }

    const receivedEmail =
      event.kind === "received"
        ? parseReceivedEmail(
            event.providerEmailId,
            await this.getReceivedEmail(event.providerEmailId),
          )
        : null;

    const processed = await this.eventDeduplicator.processOnce(
      providerEventId,
      () => {
        if (event.kind === "received") {
          if (receivedEmail === null) {
            throw new ResendProtocolError();
          }
          return this.handlers.onIncomingEmail(receivedEmail);
        }

        return this.handlers.onDeliveryEvent({
          providerEventId,
          ...event.event,
        });
      },
    );

    return processed
      ? { kind: "processed", providerEventId }
      : { kind: "duplicate", providerEventId };
  }

  private async getReceivedEmail(emailId: string): Promise<GetReceivingEmailResponse["data"]> {
    let response: GetReceivingEmailResponse;
    try {
      response = await this.client.emails.receiving.get(emailId);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new ResendTransportError();
      }
      throw error;
    }

    if (response.error !== null) {
      throw new ResendApiError(response.error.name, response.error.statusCode);
    }
    if (response.data === null) {
      throw new ResendProtocolError();
    }

    return response.data;
  }
}

export function createResendEmailAdapter(options: {
  apiKey: string;
  webhookSecret: string;
  defaultFrom?: string;
  eventDeduplicator: ResendWebhookEventDeduplicator;
  handlers: ResendWebhookHandlers;
}): ResendEmailAdapter {
  if (options.apiKey.length === 0) {
    throw new TypeError("Resend API key must not be empty");
  }

  return new ResendEmailAdapter({
    client: createResendSdkClient(options.apiKey),
    webhookSecret: options.webhookSecret,
    eventDeduplicator: options.eventDeduplicator,
    handlers: options.handlers,
    defaultFrom: options.defaultFrom,
  });
}

export function createResendSdkClient(apiKey: string): ResendSdkClient {
  if (apiKey.length === 0) {
    throw new TypeError("Resend API key must not be empty");
  }
  return new Resend(apiKey);
}

export interface ResendEnvironment {
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  RESEND_FROM_EMAIL?: string;
}

export function createResendEmailAdapterFromEnvironment(
  environment: ResendEnvironment = process.env,
  dependencies: {
    eventDeduplicator: ResendWebhookEventDeduplicator;
    handlers: ResendWebhookHandlers;
  },
): ResendEmailAdapter {
  const apiKey = environment.RESEND_API_KEY;
  const webhookSecret = environment.RESEND_WEBHOOK_SECRET;
  const defaultFrom = environment.RESEND_FROM_EMAIL;

  if (apiKey === undefined || apiKey.length === 0) {
    throw new TypeError("RESEND_API_KEY is required");
  }
  if (webhookSecret === undefined || webhookSecret.length === 0) {
    throw new TypeError("RESEND_WEBHOOK_SECRET is required");
  }
  if (defaultFrom === undefined || defaultFrom.trim().length === 0) {
    throw new TypeError("RESEND_FROM_EMAIL is required");
  }

  return createResendEmailAdapter({
    apiKey,
    webhookSecret,
    defaultFrom,
    eventDeduplicator: dependencies.eventDeduplicator,
    handlers: dependencies.handlers,
  });
}
