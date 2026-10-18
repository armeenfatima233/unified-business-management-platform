# Resend email adapter

This adapter uses Resend's official Node.js SDK. It is deliberately independent
of application routes, contact matching, lead creation, and persistence.

## Provider behavior

- Verifies each webhook with the raw request body and `svix-id`,
  `svix-timestamp`, and `svix-signature` headers.
- For `email.received`, retrieves the body through Resend's receiving API:
  receiving webhooks contain metadata and attachment metadata, not message
  bodies or attachment contents.
- Passes inbound attachment IDs, names, and content types to the backend;
  downloading attachment contents requires a separate receiving-attachments
  API integration and is not implemented here.
- Passes the provider webhook ID to `ResendWebhookEventDeduplicator`. The
  application must implement that interface using durable, atomic storage and
  mark an event complete only after handler work succeeds. It must serialize
  concurrent deliveries of the same ID, return a duplicate only after earlier
  processing succeeds, and leave failed work retryable.
- Processes `email.sent`, `email.delivered`, `email.delivery_delayed`,
  `email.bounced`, `email.complained`, `email.failed`, and `email.suppressed`
  delivery events.
- Sends plain-text and/or HTML mail through `emails.send`.

The backend must provide the durable deduplicator and typed inbound/delivery
handlers. No route, database model, recipient matching rule, or lead contract
is defined here.

## Inbound webhook backend handoff

Resend's documented `email.received` event contains `created_at` and `data`
fields including `email_id`, `message_id`, `from`, `to`, `cc`, `bcc`,
`received_for`, `subject`, and attachment metadata (`id`, `filename`,
`content_type`, with optional disposition/content ID metadata). It does not
contain the message body. The adapter retrieves that body using
`emails.receiving.get(email_id)` before calling `onIncomingEmail`.

The adapter is ready to be mounted by a backend route, but this repository has
no implemented backend server or approved route contract. The owning backend
developer must provide a public HTTPS `POST` route at a team-approved path.
That route must preserve the raw request body, map the three Svix headers to
`ResendWebhookHeaders`, call `handleWebhook`, acknowledge processed/duplicate/
ignored events with success, and return a retryable failure for transient
provider or handler failures. Do not parse and re-serialize JSON before
signature verification. Until the backend host and route are agreed, the URL
is only `https://<backend-public-host>/<team-approved-webhook-path>`; no real
webhook URL can be configured.

The backend handoff boundary is `ResendWebhookHandlers.onIncomingEmail(email:
IncomingEmail): Promise<void>` plus
`ResendWebhookEventDeduplicator.processOnce(providerEventId, work)`. To
implement customer CRM behavior behind that callback, the backend team must
agree and supply contracts for:

- **Workspace/inbox resolution:** map the received recipient (`receivedFor`
  and/or `to`) to a workspace and authorized inbox. The mapping must be
  server-controlled, not accepted from webhook payload as a trusted tenant ID.
- **Contact resolution:** normalize/match the sender address within that
  workspace and define whether/how unknown senders create contacts.
- **Conversation/message handling:** find or create the conversation for the
  resolved contact and inbox, then idempotently append the inbound message
  using the provider email/message IDs.
- **Lead handling:** decide whether an inbound email creates a lead, under
  what conditions, and return/use the approved lead contract. Neither automatic
  lead creation nor a lead source vocabulary is assumed by this adapter.

These CRM actions must run within the backend's durable idempotent processing
boundary. No contact IDs, conversation schema, lead route, source label, or
unknown-sender policy is assumed here.

## Account setup

Set the variables listed in `.env.example` in the backend's secret environment.
The receiving address is account-specific and is not discoverable without
access to that Resend account. Copy the available managed address from the
Resend dashboard's **Emails > Receiving** tab, or configure a verified domain
for inbound receiving. Create an `email.received` webhook and configure its
signing secret as `RESEND_WEBHOOK_SECRET`.

The isolated adapter can load `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and
`RESEND_FROM_EMAIL` from `process.env`; the latter is the default sender if an
individual outgoing message does not provide one. The optional live test script
uses `RESEND_TEST_TO_EMAIL` (or the legacy `RESEND_TEST_RECIPIENT`), asks for
the exact address to be typed for confirmation, and sends only from Resend's
documented `onboarding@resend.dev` test sender with subject
`QA Hackathon - Resend Integration Test`. It reports API acceptance, not inbox
delivery.

## Local checks

From this directory:

```sh
npm test
npm run typecheck
npm run test:send
```
