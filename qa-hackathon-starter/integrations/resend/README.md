# Resend email adapter

This adapter uses Resend's official Node.js SDK. It is deliberately independent
of application routes, contact matching, lead creation, and persistence.

## Provider behavior

- Verifies each webhook with the raw request body and `svix-id`,
  `svix-timestamp`, and `svix-signature` headers.
- For `email.received`, retrieves the body through Resend's receiving API:
  receiving webhooks contain metadata and attachment metadata, not message
  bodies or attachment contents.
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
