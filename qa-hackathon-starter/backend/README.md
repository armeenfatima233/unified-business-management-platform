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
| `COOKIE_SECURE` | false | set `true` behind HTTPS |
| `WORKER_INTERVAL_MS` | 1000 | how often due acknowledgement windows are checked |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | public HTTPS address providers call (tunnel or deployed host) |
| `FRONTEND_URL` | first `CORS_ORIGINS` | where alert links and OAuth redirects point |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | unset | enable escalation emails (I4); needs `integrations/resend` merged and `npm install` run there |
| `SECRETS_KEY` | generated in `data/secrets.key` | 32-byte key (64 hex) encrypting provider secrets at rest |

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
