# Connecting the LeadSafe frontend to the backend

The app now talks to the real REST API (`docs/API_CONTRACT.md`) instead of mock data.

## Run it
1. Backend: `cd ../backend && npm ci && npm run seed && npm run dev` (port 8080). Seed prints the demo login: `demo@ubmp.test` / `demo-password-1234`.
2. Frontend: `pnpm install && pnpm run dev:static` (port 3000). Optional: copy `.env.example` to `.env` to change `VITE_API_BASE_URL`.

## What changed (and where, so merges stay easy)
- **New, self-contained:** everything real lives in `client/src/live/`
  - `api/` typed API calls (one file per area), `session.tsx` (who is signed in, permissions, live updates), `pages/` the screens that show backend data, `live.css` (all styles are nested under `.lvx`, so they cannot change your design).
- **Small edits to existing files:**
  - `pages/Auth.tsx`: sign in / sign up call the backend and show its error messages (demo values are pre-filled in dev only).
  - `App.tsx`: route guard uses the server session; adds `/invite?invite=<token>` and the public form `/?form=<key>`.
  - `pages/Home.tsx`: the shell (sidebar, top bar, account menu, availability) uses the signed-in user. The old static page components further down the file are no longer rendered; they are left in place so nothing of yours is lost.
  - `api/index.ts`, `main.tsx`, `lib/trpc.ts`: untouched (the tRPC leftovers are unused).
- The role switcher is gone: the role comes from the server and cannot be changed from the browser.

## Not connected yet
Conversations, Payments, Appointments and Integrations show an honest "not connected" note until the integrations branch (`feature/calendar-resend-setup`) is merged.
