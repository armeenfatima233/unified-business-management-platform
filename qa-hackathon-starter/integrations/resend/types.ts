export interface IncomingEmailAttachment {
  id: string;
  filename: string | null;
  contentType: string;
}

export interface IncomingEmail {
  providerEmailId: string;
  providerMessageId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  receivedFor: string[];
  subject: string;
  text: string | null;
  html: string | null;
  receivedAt: Date;
  attachments: IncomingEmailAttachment[];
}

export type EmailDeliveryEventType =
  | "email.sent"
  | "email.scheduled"
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.bounced"
  | "email.complained"
  | "email.opened"
  | "email.clicked"
  | "email.failed"
  | "email.suppressed";

export interface EmailDeliveryEvent {
  providerEventId: string;
  type: EmailDeliveryEventType;
  createdAt: Date;
  providerEmailId: string;
  providerMessageId: string;
  from: string;
  to: string[];
  subject: string;
}

export interface OutgoingEmailBase {
  from?: string;
  to: string | string[];
  subject: string;
  replyTo?: string | string[];
}

export type OutgoingEmail = OutgoingEmailBase &
  (
    | { text: string; html?: string }
    | { html: string; text?: string }
  );

export interface OutgoingEmailReceipt {
  providerEmailId: string;
}

export interface ResendWebhookHeaders {
  "svix-id"?: string;
  "svix-timestamp"?: string;
  "svix-signature"?: string;
}

export interface ResendWebhookEventDeduplicator {
  /**
   * Durably serializes each ID, returning false only when its work already succeeded.
   * Failed work must remain retryable; the adapter does not store IDs.
   */
  processOnce(
    providerEventId: string,
    work: () => Promise<void> | void,
  ): Promise<boolean>;
}

export interface ResendWebhookHandlers {
  onIncomingEmail(email: IncomingEmail): Promise<void> | void;
  onDeliveryEvent(event: EmailDeliveryEvent): Promise<void> | void;
}

export type ResendWebhookResult =
  | { kind: "processed"; providerEventId: string }
  | { kind: "duplicate"; providerEventId: string }
  | { kind: "ignored"; providerEventId: string; reason: "unsupported_event" };
