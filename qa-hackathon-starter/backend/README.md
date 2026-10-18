# Backend (core)

Express 5 + TypeScript on Node 24+ with SQLite (`node:sqlite`). Contract: `../docs/API_CONTRACT.md`.

## Run it
```
npm install
copy .env.example .env      # optional: defaults work without it
npm run seed                # optional: demo workspace with sample data
npm run dev                 # http://localhost:8080  (health: /api/v1/health)
```
Demo logins after `npm run seed`: `demo@ubmp.test` (Owner) and `noah@`, `priya@`, `liam@ubmp.test`, password
`demo-password-1234`. The seed uses short acknowledgement windows (60 s) so escalation can be watched.

## Check it
```
npm run typecheck
npm test            # all suites, real HTTP against throwaway databases
```

## Configuration (all outside the source; see `.env.example`)
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | listen port |
| `DB_PATH` | `./data/app.db` | SQLite file (kept out of git) |
| `CORS_ORIGINS` | `http://localhost:3000` | frontend origins allowed to call with cookies |
| `COOKIE_SECURE` | false | set `true` behind HTTPS; required for the session cookie on the public Google OAuth callback |
| `WORKER_INTERVAL_MS` | 1000 | how often due acknowledgement windows are checked |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | public HTTPS address providers call (tunnel or deployed host) |
| `FRONTEND_URL` | first `CORS_ORIGINS` | where alert links and OAuth redirects point |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | unset | enable Resend escalation emails (I4) |
| `SECRETS_KEY` | generated in `data/secrets.key` | 32-byte key (64 hex) encrypting provider secrets at rest |
| `GOOGLE_CALENDAR_CLIENT_ID` | — | Google OAuth web client ID |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | — | Google OAuth web client secret |
| `GOOGLE_CALENDAR_REDIRECT_URI` | — | Exact callback URL registered in Google Cloud |

## Connected integration seams

- Resend's public webhook is `POST /api/v1/webhooks/resend/:webhookKey`. It verifies the raw Svix body,
  resolves the workspace from the saved connection, matches or creates the sender contact, records the
  email conversation/message, and creates a `message`-source lead transactionally and idempotently.
  The connection's encrypted secrets contain `apiKey` and `webhookSecret`; its non-secret config may
  contain `fromEmail` and `inboundAddress`. Configure Resend's webhook URL as
  `${PUBLIC_BASE_URL}/api/v1/webhooks/resend/${webhook_key}`.
- Escalation dispatch, recipient resolution, failure recording, recipient settings, alert history, and
  retry endpoints are owned by `src/integrations/alerts.ts`. Employees configure their recipient at
  `GET/PUT/DELETE /api/v1/me/notification-destination`; if unset, their account email is used. Admins
  can review `GET /api/v1/notifications/alerts` and retry with
  `POST /api/v1/notifications/alerts/:id/retry`. Resend sender credentials are configured with
  `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. Provisioning the workspace-specific Resend webhook connection
  is not exposed as an API route yet.
- Google OAuth starts at `GET /api/v1/integrations/google/calendar/oauth/start` and returns to
  `GET /api/v1/integrations/google/calendar/oauth/callback`. OAuth state is session-bound and one-use;
  member credentials are encrypted in the existing Google integration connection. The callback redirects
  to the configured `FRONTEND_URL` with only `google=connected`, `google=denied`, or `google=error`;
  it validates the saved session-bound state and does not forward OAuth codes, tokens, or provider error
  details. Configure `FRONTEND_URL` as a trusted HTTPS origin and set `COOKIE_SECURE=true` when serving
  over HTTPS so the callback receives the authenticated session cookie. Calendar appointment CRUD routes
  are not part of this backend wiring.

## How it is organised (Q14)
```
src/app.ts            wiring, error handling
src/db.ts             schema + migrations (the only file that knows SQLite)
src/auth, members     sessions, invitations, roles, permissions, availability
src/middleware        requireAuth, requirePermission, CORS/CSRF/headers
src/crm               contacts, companies, pipelines, custom fields, opportunities, saved lists
src/leads             service.ts = all lead rules; routes.ts; worker.ts = durable timer
src/audit, dashboard, events
src/integrations/     index.ts = where the integrations module plugs in (mount routers, background ticks)
                      core.ts = processOnce, encrypted secrets, connections, sync history; key.ts = secrets key
drafts/               reference-only integration drafts (not built, not tested)
```
Rules live in services (`leads/service.ts`), routes only validate and call them, and every mutation that must
be traced writes its audit row in the same transaction.

## Guarantees worth knowing
- One accountable owner per lead: every change re-reads the lead inside a `BEGIN IMMEDIATE` transaction.
- Escalation timers are columns in the database and a worker polls them, so a restart loses nothing.
- Removing a member is a soft removal: history stays, open leads move, sessions end.
- Opening an older database file upgrades it (adds tables/columns, gives old workspaces a pipeline and form key).
