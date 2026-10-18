# Google Calendar integration adapter

**Requirement IDs:** I3.1–I3.7.

This isolated server-side TypeScript module uses Google's official `googleapis`
Node client. It implements OAuth 2.0 authorization-code exchange, one-time
hashed state validation, refresh and revocation handling, free/busy queries,
conflict-aware event creation/rescheduling, cancellation, and timezone-aware
event date handling.

Automated tests use labelled local stubs for Google APIs. They verify adapter
behavior and do not prove a real Google account authorization or Calendar API
operation. No live Google credentials are included.

## Backend handoff boundaries

No application route, authentication/session implementation, or database
schema is defined here. Backend-owned storage and identity interfaces are
required:

- `GoogleCalendarOAuthStateStore`: persist a hash of random OAuth state with
  expiration and a hash of the initiating authenticated session binding, then
  atomically consume it once only for that same session. Store authenticated
  member context server-side; never accept workspace/member IDs from callback
  query parameters.
- `GoogleCalendarConnectionStore`: load/save OAuth credentials server-side,
  persist `connected`/`revoked`/`reauthorization_required`/`disconnected`
  status, encrypt tokens at rest, scope them to workspace/member, and remove
  credentials on disconnect.
- `GoogleCalendarCrmContextResolver`: derive workspace/member context from the
  authenticated server session.
- `GoogleCalendarAppointmentLinkStore`: save/clear the provider event ID on an
  already authorized appointment. The adapter requires the backend to provide
  opaque appointment/contact/opportunity references and does not create or
  mutate CRM records.
- The backend appointment service must validate that the appointment and any
  contact/opportunity references belong to the session workspace, persist the
  appointment's own start/end/time zone and status, and associate the returned
  Google event ID. If `GoogleCalendarLinkPersistenceError` is returned after a
  remote create/update/delete, reconcile using its event ID instead of blindly
  retrying a create.

Use these service methods from team-approved backend routes; this module does
not define route names or payload contracts. Authentication/authorization,
workspace isolation, appointment validation, and durable storage remain
backend responsibilities. Pass a server-derived session binding to both OAuth
start and callback handling. The callback must be associated with the same
authenticated session; do not authorize based on state alone. Calendar conflict
checking is subject to a check-then-write race if events are changed
concurrently outside this application.

The caller must provide RFC 3339 date-time strings with an explicit UTC offset
or `Z`, plus a valid IANA time zone (for example `America/New_York`). Offset-
free local timestamps are rejected to avoid daylight-saving ambiguity.
Google's free/busy API returns busy intervals; event creation checks them before
inserting, while rescheduling lists events and excludes the event being moved.

## Google Cloud setup

1. Create/select a project in Google Cloud Console and enable **Google Calendar
   API**.
2. Configure the OAuth consent screen for the intended audience. Add required
   test users while the app is in testing. Publish/verify the app as required
   before production use of sensitive/restricted scopes.
3. Create an OAuth client ID with application type **Web application**.
4. Register the exact server callback URI as an authorized redirect URI. Set
   this same URI in `GOOGLE_CALENDAR_REDIRECT_URI`.
5. Provide the OAuth client ID and client secret to the backend secret manager
   (or local ignored `.env` for development), using `.env.example` as the key
   template. Never expose the client secret or user tokens to a browser.
6. Deploy the backend callback over HTTPS. The backend must implement the
   state, connection, CRM context, and appointment-link interfaces described
   above before enabling this provider.
7. Validate OAuth consent and Calendar API behavior with a designated Google
   test account; unit tests alone do not constitute provider verification.

Requested scopes are:

- `https://www.googleapis.com/auth/calendar.events` for event CRUD.
- `https://www.googleapis.com/auth/calendar.events.freebusy` for free/busy.

## Local checks

From this directory:

```sh
npm test
npm run typecheck
```
