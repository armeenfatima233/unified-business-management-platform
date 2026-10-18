import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { GoogleCalendarSdk } from "../../integrations/google-calendar/google-calendar-adapter.ts";
import type { ResendSdkClient } from "../../integrations/resend/resend-email-adapter.ts";
import { getConnection, saveConnection, type IntegrationContext } from "../src/integrations/core.ts";
import { resendWebhookRouter } from "../src/integrations/resend.ts";
import { googleCalendarOAuthRouter } from "../src/integrations/google-calendar.ts";
import { startApp, type TestApp } from "./helpers.ts";

let app: TestApp;
let resendClientMode: "valid" | "invalid" = "valid";
let receivedEmailId = "";
let googleTokenExchangeFails = false;

const fakeResendClient = (_apiKey: string): ResendSdkClient =>
  ({
    emails: {
      send: async () => ({ data: { id: "re_alert_1" }, error: null }),
      receiving: {
        get: async (id: string) => ({
          error: null,
          data: {
            id,
            from: "Riley Example <riley@example.com>",
            to: ["inbound@example.test"],
            cc: [],
            bcc: [],
            received_for: ["inbound@example.test"],
            subject: "Interested in the platform",
            text: "Please contact me about pricing.",
            html: null,
            created_at: "2026-10-18T08:00:00.000Z",
            message_id: "<inbound-1@example.com>",
            attachments: [],
          },
        }),
      },
    },
    webhooks: {
      verify: ({ payload }: { payload: string }) => {
        if (resendClientMode === "invalid") throw new Error("invalid signature");
        return JSON.parse(payload);
      },
    },
  }) as unknown as ResendSdkClient;

const googleSdk: GoogleCalendarSdk = {
  createOAuthClient: () => ({
    generateAuthUrl: (options) =>
      `https://accounts.google.test/authorize?state=${encodeURIComponent(options.state)}`,
    getToken: async () => {
      if (googleTokenExchangeFails) throw new Error("provider details must not leak");
      return {
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expiry_date: Date.now() + 60_000,
        },
      };
    },
    setCredentials: () => undefined,
    refreshAccessToken: async () => ({
      credentials: { access_token: "refreshed-token" },
    }),
    revokeCredentials: async () => undefined,
  }),
  createCalendarApi: () => ({
    queryFreeBusy: async () => ({ data: {} }),
    listEvents: async () => ({ data: { items: [] } }),
    insertEvent: async () => ({ data: { id: "event-1" } }),
    patchEvent: async () => ({ data: { id: "event-1" } }),
    deleteEvent: async () => undefined,
  }),
};

const googleEnvironment = {
  GOOGLE_CALENDAR_CLIENT_ID: "client-id",
  GOOGLE_CALENDAR_CLIENT_SECRET: "client-secret",
  GOOGLE_CALENDAR_REDIRECT_URI:
    "https://api.example.test/api/v1/integrations/google/calendar/oauth/callback",
};

before(async () => {
  app = await startApp({
    integrations: {
      secretsKey: Buffer.alloc(32, 9),
      publicBaseUrl: "https://api.example.test",
      frontendUrl: "https://app.example.test",
      mount: (expressApp, ctx) => {
        expressApp.use(
          "/api/v1/webhooks/resend",
          resendWebhookRouter(ctx, fakeResendClient),
        );
        expressApp.use(
          "/api/v1/integrations/google/calendar",
          googleCalendarOAuthRouter(ctx, googleEnvironment, googleSdk),
        );
      },
    },
  });
});

after(() => app.close());

function integrationContext(): IntegrationContext {
  return {
    db: app.db,
    fetch: (url, init) => fetch(url, init),
    secretsKey: Buffer.alloc(32, 9),
    publicBaseUrl: "https://api.example.test",
    frontendUrl: "https://app.example.test",
  };
}

function receivedWebhook(eventId: string) {
  return {
    type: "email.received",
    created_at: "2026-10-18T08:00:00.000Z",
    data: {
      email_id: receivedEmailId,
      message_id: "<inbound-1@example.com>",
      from: "Riley Example <riley@example.com>",
      to: ["inbound@example.test"],
      cc: [],
      bcc: [],
      received_for: ["inbound@example.test"],
      subject: "Interested in the platform",
      created_at: "2026-10-18T08:00:00.000Z",
    },
    id: eventId,
  };
}

async function createOAuthTestSession(suffix: string) {
  const response = await fetch(`${app.base}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `oauth-${suffix}@example.test`,
      password: "OAuth-Test-Password-123!",
      name: "OAuth Test",
      workspaceName: `OAuth ${suffix}`,
    }),
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    user: { id: string };
    workspace: { id: string };
  };
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return {
    userId: body.user.id,
    workspaceId: body.workspace.id,
    cookie: setCookie.split(";")[0]!,
  };
}

async function startGoogleOAuth(cookie: string): Promise<string> {
  const response = await fetch(
    `${app.base}/integrations/google/calendar/oauth/start`,
    { headers: { cookie } },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { authorizationUrl: string };
  const state = new URL(body.authorizationUrl).searchParams.get("state");
  assert.ok(state);
  return state;
}

describe("backend Resend integration", () => {
  it("authenticates, deduplicates, and maps inbound mail to contact, conversation, message, and lead", async () => {
    const team = await app.team(1);
    const ctx = integrationContext();
    const connection = saveConnection(
      ctx,
      team.workspaceId,
      "resend",
      null,
      { inboundAddress: "inbound@example.test", fromEmail: "sales@example.test" },
      { apiKey: "test-api-key", webhookSecret: "test-webhook-secret" },
    );
    receivedEmailId = "re_received_1";
    resendClientMode = "valid";
    const event = receivedWebhook("evt_received_1");
    const sendEvent = async () => {
      const response = await fetch(
        `${app.base}/webhooks/resend/${connection.webhook_key}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "svix-id": "evt_received_1",
            "svix-timestamp": "1792310400",
            "svix-signature": "v1,test",
          },
          body: JSON.stringify(event),
        },
      );
      return { status: response.status, body: await response.json() };
    };

    assert.equal((await sendEvent()).status, 200);
    const duplicate = await sendEvent();
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.kind, "duplicate");
    assert.equal(
      (app.db.prepare("SELECT COUNT(*) AS count FROM contacts WHERE workspace_id = ?").get(team.workspaceId) as { count: number }).count,
      1,
    );
    assert.equal(
      (app.db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE workspace_id = ? AND channel = 'email'").get(team.workspaceId) as { count: number }).count,
      1,
    );
    assert.equal(
      (app.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE workspace_id = ? AND direction = 'inbound'").get(team.workspaceId) as { count: number }).count,
      1,
    );
    const lead = app.db
      .prepare("SELECT source, message FROM leads WHERE workspace_id = ?")
      .get(team.workspaceId) as { source: string; message: string };
    assert.equal(lead.source, "message");
    assert.match(lead.message, /pricing/);
  });

  it("rejects invalid webhook signatures without persisting lead data", async () => {
    const team = await app.team(0);
    const ctx = integrationContext();
    const connection = saveConnection(
      ctx,
      team.workspaceId,
      "resend",
      null,
      {},
      { apiKey: "test-api-key", webhookSecret: "test-webhook-secret" },
    );
    receivedEmailId = "re_received_bad";
    resendClientMode = "invalid";
    const response = await fetch(
      `${app.base}/webhooks/resend/${connection.webhook_key}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "evt_bad_signature",
          "svix-timestamp": "1792310400",
          "svix-signature": "v1,invalid",
        },
        body: JSON.stringify(receivedWebhook("evt_bad_signature")),
      },
    );
    assert.equal(response.status, 401);
    assert.equal(
      (app.db.prepare("SELECT COUNT(*) AS count FROM leads WHERE workspace_id = ?").get(team.workspaceId) as { count: number }).count,
      0,
    );
    resendClientMode = "valid";
  });

});

describe("Google Calendar OAuth backend routes", () => {
  it("redirects successful consent to the configured frontend without exposing codes or state", async () => {
    const session = await createOAuthTestSession("success");
    const state = await startGoogleOAuth(session.cookie);
    const callback = await fetch(
      `${app.base}/integrations/google/calendar/oauth/callback?code=code-1&state=${encodeURIComponent(state)}&redirect_uri=https%3A%2F%2Fevil.example`,
      { headers: { cookie: session.cookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 302);
    const location = callback.headers.get("location");
    assert.equal(location, "https://app.example.test/?google=connected");
    assert.ok(!location?.includes("code-1"));
    assert.ok(!location?.includes(state));

    const connection = getConnection(
      app.db,
      session.workspaceId,
      "google",
      session.userId,
    );
    assert.ok(connection);
    assert.ok(connection.secrets_enc);
    assert.ok(!connection.secrets_enc.includes("refresh-token"));

    const replay = await fetch(
      `${app.base}/integrations/google/calendar/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { headers: { cookie: session.cookie }, redirect: "manual" },
    );
    assert.equal(replay.status, 400);
  });

  it("redirects denied consent to the configured frontend after validating state", async () => {
    const session = await createOAuthTestSession("denied");
    const state = await startGoogleOAuth(session.cookie);
    const callback = await fetch(
      `${app.base}/integrations/google/calendar/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}&error_description=private-provider-details`,
      { headers: { cookie: session.cookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 302);
    const location = callback.headers.get("location");
    assert.equal(location, "https://app.example.test/?google=denied");
    assert.ok(!location?.includes("access_denied"));
    assert.ok(!location?.includes("private-provider-details"));
    assert.ok(!location?.includes(state));
  });

  it("redirects other provider failures without revealing provider details", async () => {
    const session = await createOAuthTestSession("provider-error");
    const state = await startGoogleOAuth(session.cookie);
    const callback = await fetch(
      `${app.base}/integrations/google/calendar/oauth/callback?error=server_error&error_description=private-provider-details&state=${encodeURIComponent(state)}`,
      { headers: { cookie: session.cookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 302);
    const location = callback.headers.get("location");
    assert.equal(location, "https://app.example.test/?google=error");
    assert.ok(!location?.includes("server_error"));
    assert.ok(!location?.includes("private-provider-details"));
    assert.ok(!location?.includes(state));

    const exchangeSession = await createOAuthTestSession("exchange-error");
    const exchangeState = await startGoogleOAuth(exchangeSession.cookie);
    googleTokenExchangeFails = true;
    try {
      const exchangeFailure = await fetch(
        `${app.base}/integrations/google/calendar/oauth/callback?code=private-code&state=${encodeURIComponent(exchangeState)}`,
        { headers: { cookie: exchangeSession.cookie }, redirect: "manual" },
      );
      assert.equal(exchangeFailure.status, 302);
      assert.equal(
        exchangeFailure.headers.get("location"),
        "https://app.example.test/?google=error",
      );
      assert.ok(!exchangeFailure.headers.get("location")?.includes("private-code"));
    } finally {
      googleTokenExchangeFails = false;
    }
  });

  it("rejects a callback made from a different authenticated session", async () => {
    const team = await app.team(1);
    const start = await team.owner(
      "GET",
      "/integrations/google/calendar/oauth/start",
    );
    const state = new URL(start.json.authorizationUrl).searchParams.get("state");
    assert.ok(state);
    const callback = await team.users[0]!.api(
      "GET",
      `/integrations/google/calendar/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 400);
  });
});
