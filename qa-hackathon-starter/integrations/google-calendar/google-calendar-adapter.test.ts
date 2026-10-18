import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { OAuth2Client, type Credentials } from "google-auth-library";
import type { calendar_v3 } from "googleapis";
import {
  GoogleCalendarAdapter,
  GoogleCalendarConflictError,
  GoogleCalendarConnectionError,
  GoogleCalendarLinkPersistenceError,
  GoogleCalendarOAuthError,
  GoogleCalendarOAuthStateError,
  GoogleCalendarProviderError,
  GoogleCalendarRevokedError,
  createGoogleCalendarAdapterFromEnvironment,
  type GoogleCalendarSdk,
} from "./google-calendar-adapter.ts";
import type {
  GoogleCalendarAppointmentLinkStore,
  GoogleCalendarConnectionStore,
  GoogleCalendarMemberContext,
  GoogleCalendarOAuthStateStore,
} from "./types.ts";

type CalendarApi = ReturnType<GoogleCalendarSdk["createCalendarApi"]>;

const context = { workspaceId: "workspace_1", memberId: "member_1" };
const sessionBinding = "authenticated-session-binding";
const sessionBindingHash = createHash("sha256")
  .update(sessionBinding)
  .digest("hex");
const now = Date.parse("2026-10-18T00:00:00.000Z");
const range = {
  start: "2026-10-19T10:00:00-04:00",
  end: "2026-10-19T11:00:00-04:00",
  timeZone: "America/New_York",
};

class StateStore implements GoogleCalendarOAuthStateStore {
  readonly entries = new Map<
    string,
    {
      context: GoogleCalendarMemberContext;
      sessionBindingHash: string;
      expiresAt: Date;
    }
  >();

  async create(
    hash: string,
    memberContext: GoogleCalendarMemberContext,
    bindingHash: string,
    expiresAt: Date,
  ): Promise<void> {
    this.entries.set(hash, {
      context: memberContext,
      sessionBindingHash: bindingHash,
      expiresAt,
    });
  }

  async consume(
    hash: string,
    bindingHash: string,
  ): Promise<GoogleCalendarMemberContext | null> {
    const entry = this.entries.get(hash);
    if (
      !entry ||
      entry.expiresAt.getTime() <= now ||
      entry.sessionBindingHash !== bindingHash
    ) {
      return null;
    }
    this.entries.delete(hash);
    return entry.context;
  }
}

class ConnectionStore implements GoogleCalendarConnectionStore {
  credentials: Credentials | null = {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expiry_date: now + 60 * 60 * 1000,
  };
  readonly statuses: string[] = [];
  readonly saved: Credentials[] = [];
  deleted = false;

  async getCredentials(): Promise<Credentials | null> {
    return this.credentials;
  }

  async saveCredentials(
    _memberContext: GoogleCalendarMemberContext,
    credentials: Credentials,
  ): Promise<void> {
    this.credentials = credentials;
    this.saved.push(credentials);
  }

  async setStatus(
    _memberContext: GoogleCalendarMemberContext,
    status: "connected" | "revoked" | "reauthorization_required" | "disconnected",
  ): Promise<void> {
    this.statuses.push(status);
  }

  async deleteCredentials(): Promise<void> {
    this.credentials = null;
    this.deleted = true;
  }
}

class AppointmentLinkStore implements GoogleCalendarAppointmentLinkStore {
  readonly linked: string[] = [];
  cleared = false;

  async setGoogleEventId(
    _memberContext: GoogleCalendarMemberContext,
    _references: { appointmentId: string; contactId?: string; opportunityId?: string },
    eventId: string,
  ): Promise<void> {
    this.linked.push(eventId);
  }

  async clearGoogleEventId(): Promise<void> {
    this.cleared = true;
  }
}

function makeSdk(options: {
  tokens?: Credentials;
  refresh?: () => Promise<Credentials>;
  freeBusy?: (request: {
    requestBody: {
      timeMin: string;
      timeMax: string;
      timeZone: string;
      items: Array<{ id: string }>;
    };
  }) => Promise<unknown>;
  listEvents?: () => Promise<unknown>;
  insertEvent?: (request: {
    calendarId: string;
    requestBody: calendar_v3.Schema$Event;
  }) => Promise<unknown>;
  patchEvent?: () => Promise<unknown>;
  deleteEvent?: (request: { calendarId: string; eventId: string }) => Promise<unknown>;
  onAuthUrl?: (options: {
    access_type?: string;
    include_granted_scopes?: boolean;
    prompt?: string;
    redirect_uri?: string;
    scope?: string | string[];
    state?: string;
  }) => string;
} = {}) {
  const oauthClient = new OAuth2Client();
  let credentials: Credentials = {};
  let exchangedCode = "";
  let refreshCalls = 0;
  let revoked = false;
  Object.defineProperty(oauthClient, "generateAuthUrl", {
    value: (authOptions: Parameters<OAuth2Client["generateAuthUrl"]>[0]) =>
      options.onAuthUrl?.(authOptions ?? {}) ??
      `https://accounts.google.test/auth?state=${String(authOptions?.state)}`,
  });
  Object.defineProperty(oauthClient, "getToken", {
    value: async (code: string) => {
      exchangedCode = code;
      return { tokens: options.tokens ?? { access_token: "oauth-access", refresh_token: "oauth-refresh" } };
    },
  });
  Object.defineProperty(oauthClient, "setCredentials", {
    value: (value: Credentials) => {
      credentials = value;
    },
  });
  Object.defineProperty(oauthClient, "refreshAccessToken", {
    value: async () => {
      refreshCalls += 1;
      if (options.refresh) {
        const refreshed = await options.refresh();
        return { credentials: refreshed };
      }
      return { credentials: { access_token: "refreshed-access", expiry_date: now + 3_600_000 } };
    },
  });
  Object.defineProperty(oauthClient, "revokeCredentials", {
    value: async () => {
      revoked = true;
    },
  });

  const calendarApi = {
    queryFreeBusy: async (request: Parameters<CalendarApi["queryFreeBusy"]>[0]) =>
      (options.freeBusy?.(request) ??
        Promise.resolve({
          data: {
            calendars: {
              primary: {
                busy: [],
              },
            },
          },
        })) as never,
    listEvents: async () =>
      (options.listEvents?.() ??
        Promise.resolve({
          data: {
            items: [],
          },
        })) as never,
    insertEvent: async (request: Parameters<CalendarApi["insertEvent"]>[0]) =>
      (options.insertEvent?.(request) ??
        Promise.resolve({
          data: { id: "google_event_1", htmlLink: "https://calendar.google.test/event" },
        })) as never,
    patchEvent: async () =>
      (options.patchEvent?.() ??
        Promise.resolve({
          data: { id: "google_event_1", htmlLink: "https://calendar.google.test/event" },
        })) as never,
    deleteEvent: async (request: Parameters<CalendarApi["deleteEvent"]>[0]) =>
      (options.deleteEvent?.(request) ?? Promise.resolve({ data: {} })) as never,
  };
  const sdk: GoogleCalendarSdk = {
    createOAuthClient: () => oauthClient,
    createCalendarApi: () => calendarApi,
  };

  return {
    sdk,
    get credentials() {
      return credentials;
    },
    get exchangedCode() {
      return exchangedCode;
    },
    get refreshCalls() {
      return refreshCalls;
    },
    get revoked() {
      return revoked;
    },
  };
}

function setup(options: Parameters<typeof makeSdk>[0] = {}) {
  const stateStore = new StateStore();
  const connectionStore = new ConnectionStore();
  const appointmentLinkStore = new AppointmentLinkStore();
  const provider = makeSdk(options);
  const adapter = new GoogleCalendarAdapter({
    configuration: {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://app.example.test/oauth/google/callback",
    },
    oauthStateStore: stateStore,
    connectionStore,
    appointmentLinkStore,
    sdk: provider.sdk,
    now: () => now,
  });
  return { adapter, stateStore, connectionStore, appointmentLinkStore, provider };
}

const appointmentReferences = { appointmentId: "appointment_1", contactId: "contact_1" };
const appointment = { ...range, summary: "Consultation", description: "Introductory call" };

test("creates an offline OAuth URL and stores only a hashed, expiring state", async () => {
  let capturedState = "";
  const configured = setup({
    onAuthUrl: (options) => {
      capturedState = options.state ?? "";
      assert.equal(options.access_type, "offline");
      assert.equal(options.prompt, "consent");
      assert.deepEqual(options.scope, [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.events.freebusy",
      ]);
      return "https://accounts.google.test/auth";
    },
  });

  assert.equal(
    await configured.adapter.createAuthorizationUrl(context, sessionBinding),
    "https://accounts.google.test/auth",
  );
  const hash = createHash("sha256").update(capturedState).digest("hex");
  assert.equal(configured.stateStore.entries.has(hash), true);
  assert.equal(configured.stateStore.entries.has(capturedState), false);
  assert.equal(
    configured.stateStore.entries.get(hash)?.expiresAt.getTime(),
    now + 10 * 60 * 1000,
  );
});

test("uses Google's official OAuth client to build the provider authorization URL", async () => {
  const adapter = createGoogleCalendarAdapterFromEnvironment(
    {
      GOOGLE_CALENDAR_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      GOOGLE_CALENDAR_CLIENT_SECRET: "non-secret-test-value",
      GOOGLE_CALENDAR_REDIRECT_URI: "https://app.example.test/oauth/google/callback",
    },
    {
      oauthStateStore: new StateStore(),
      connectionStore: new ConnectionStore(),
      appointmentLinkStore: new AppointmentLinkStore(),
    },
  );

  const authorizationUrl = new URL(
    await adapter.createAuthorizationUrl(context, sessionBinding),
  );
  assert.equal(authorizationUrl.hostname, "accounts.google.com");
  assert.equal(authorizationUrl.searchParams.get("access_type"), "offline");
  assert.equal(authorizationUrl.searchParams.get("prompt"), "consent");
  assert.equal(
    authorizationUrl.searchParams.get("redirect_uri"),
    "https://app.example.test/oauth/google/callback",
  );
  assert.ok(authorizationUrl.searchParams.get("state"));
  assert.deepEqual(
    authorizationUrl.searchParams.get("scope")?.split(" "),
    [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
    ],
  );
});

test("rejects missing, expired, and replayed OAuth state before exchanging a code", async () => {
  const { adapter, stateStore, provider } = setup();
  await assert.rejects(
    adapter.completeAuthorization("auth-code", "unknown", sessionBinding),
    GoogleCalendarOAuthStateError,
  );
  assert.equal(provider.exchangedCode, "");

  const expiredState = "expired-state";
  const expiredHash = createHash("sha256").update(expiredState).digest("hex");
  stateStore.entries.set(expiredHash, {
    context,
    sessionBindingHash,
    expiresAt: new Date(now),
  });
  await assert.rejects(
    adapter.completeAuthorization("auth-code", expiredState, sessionBinding),
    GoogleCalendarOAuthStateError,
  );
  assert.equal(provider.exchangedCode, "");
});

test("exchanges callback code and saves credentials server-side without returning tokens", async () => {
  const { adapter, stateStore, connectionStore, provider } = setup();
  const state = "valid-state";
  stateStore.entries.set(createHash("sha256").update(state).digest("hex"), {
    context,
    sessionBindingHash,
    expiresAt: new Date(now + 1000),
  });

  await assert.rejects(
    adapter.completeAuthorization("one-time-code", state, "different-session"),
    GoogleCalendarOAuthStateError,
  );
  assert.deepEqual(
    await adapter.completeAuthorization("one-time-code", state, sessionBinding),
    context,
  );
  assert.equal(provider.exchangedCode, "one-time-code");
  assert.equal(connectionStore.credentials?.refresh_token, "oauth-refresh");
  assert.deepEqual(connectionStore.statuses, ["connected"]);
  await assert.rejects(
    adapter.completeAuthorization("one-time-code", state, sessionBinding),
    GoogleCalendarOAuthStateError,
  );
});

test("requires a refresh token when first connecting an account", async () => {
  const { adapter, stateStore, connectionStore } = setup({
    tokens: { access_token: "access-without-refresh" },
  });
  connectionStore.credentials = null;
  const state = "no-refresh";
  stateStore.entries.set(createHash("sha256").update(state).digest("hex"), {
    context,
    sessionBindingHash,
    expiresAt: new Date(now + 1000),
  });

  await assert.rejects(
    adapter.completeAuthorization("one-time-code", state, sessionBinding),
    GoogleCalendarOAuthError,
  );
  assert.equal(connectionStore.saved.length, 0);
  assert.deepEqual(connectionStore.statuses, ["reauthorization_required"]);
});

test("refreshes expiring credentials and persists the new server-side tokens", async () => {
  const { adapter, connectionStore, provider } = setup();
  connectionStore.credentials = {
    access_token: "expired-access",
    refresh_token: "refresh-token",
    expiry_date: now - 1000,
  };

  assert.deepEqual(await adapter.getFreeBusy(context, range), []);
  assert.equal(provider.refreshCalls, 1);
  assert.equal(connectionStore.credentials?.access_token, "refreshed-access");
  assert.equal(connectionStore.saved.length, 1);
  assert.deepEqual(connectionStore.statuses, ["connected"]);
});

test("marks connections revoked when Google rejects a refresh token", async () => {
  const { adapter, connectionStore } = setup({
    refresh: async () => {
      throw Object.assign(new Error("invalid_grant"), {
        response: { data: { error: "invalid_grant" }, status: 400 },
      });
    },
  });
  connectionStore.credentials = {
    access_token: "expired-access",
    refresh_token: "revoked-refresh-token",
    expiry_date: now - 1000,
  };

  await assert.rejects(adapter.getFreeBusy(context, range), GoogleCalendarRevokedError);
  assert.deepEqual(connectionStore.statuses, ["revoked"]);
});

test("requires reauthorization if refresh succeeds without usable credentials", async () => {
  const { adapter, connectionStore } = setup({
    refresh: async () => ({}),
  });
  connectionStore.credentials = {
    access_token: "expired-access",
    refresh_token: "refresh-token",
    expiry_date: now - 1000,
  };

  await assert.rejects(
    adapter.getFreeBusy(context, range),
    GoogleCalendarConnectionError,
  );
  assert.equal(connectionStore.saved.length, 0);
  assert.deepEqual(connectionStore.statuses, ["reauthorization_required"]);
});

test("returns free/busy periods using the requested RFC3339 range and timezone", async () => {
  let captured: unknown;
  const { adapter } = setup({
    freeBusy: async (request) => {
      captured = request.requestBody;
      return {
        data: {
          calendars: {
            primary: { busy: [{ start: range.start, end: range.end }] },
          },
        },
      };
    },
  });

  assert.deepEqual(await adapter.getFreeBusy(context, range), [
    { start: range.start, end: range.end },
  ]);
  assert.deepEqual(captured, {
    timeMin: range.start,
    timeMax: range.end,
    timeZone: range.timeZone,
    items: [{ id: "primary" }],
  });
});

test("rejects invalid timezones, offset-free local times, and reversed intervals", async () => {
  const { adapter } = setup();
  await assert.rejects(
    adapter.getFreeBusy(context, { ...range, timeZone: "Not/A_Timezone" }),
    TypeError,
  );
  await assert.rejects(
    adapter.getFreeBusy(context, {
      ...range,
      start: "2026-10-19T10:00:00",
    }),
    TypeError,
  );
  await assert.rejects(
    adapter.getFreeBusy(context, {
      ...range,
      start: range.end,
      end: range.start,
    }),
    TypeError,
  );
});

test("rejects creation on a busy time and creates/links a timezone-aware event when free", async () => {
  let insertedBody: unknown;
  let insertedCalendarId = "";
  const conflictAdapter = setup({
    freeBusy: async () => ({
      data: {
        calendars: { primary: { busy: [{ start: range.start, end: range.end }] } },
      },
    }),
  });
  await assert.rejects(
    conflictAdapter.adapter.createAppointment(
      context,
      appointmentReferences,
      appointment,
    ),
    GoogleCalendarConflictError,
  );

  const available = setup({
    insertEvent: async (request) => {
      insertedCalendarId = request.calendarId;
      insertedBody = request.requestBody;
      return {
        data: {
          id: "google_event_1",
          htmlLink: "https://calendar.google.test/event",
        },
      };
    },
  });
  assert.deepEqual(
    await available.adapter.createAppointment(
      context,
      appointmentReferences,
      appointment,
    ),
    {
      eventId: "google_event_1",
      htmlLink: "https://calendar.google.test/event",
    },
  );
  assert.deepEqual(insertedBody, {
    summary: appointment.summary,
    description: appointment.description,
    start: { dateTime: appointment.start, timeZone: appointment.timeZone },
    end: { dateTime: appointment.end, timeZone: appointment.timeZone },
  });
  assert.equal(insertedCalendarId, "primary");
  assert.deepEqual(available.appointmentLinkStore.linked, ["google_event_1"]);
});

test("reports a created Google event if CRM link persistence fails", async () => {
  const brokenLinks: GoogleCalendarAppointmentLinkStore = {
    setGoogleEventId: async () => {
      throw new Error("backend storage unavailable");
    },
    clearGoogleEventId: async () => {},
  };
  const provider = makeSdk();
  const adapter = new GoogleCalendarAdapter({
    configuration: {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://app.example.test/oauth/google/callback",
    },
    oauthStateStore: new StateStore(),
    connectionStore: new ConnectionStore(),
    appointmentLinkStore: brokenLinks,
    sdk: provider.sdk,
    now: () => now,
  });

  await assert.rejects(
    adapter.createAppointment(context, appointmentReferences, appointment),
    (error: Error) => {
      assert.ok(error instanceof GoogleCalendarLinkPersistenceError);
      assert.equal(error.eventId, "google_event_1");
      return true;
    },
  );
});

test("blocks conflicting reschedules while excluding the event being moved", async () => {
  const conflict = setup({
    listEvents: async () => ({
      data: {
        items: [
          {
            id: "other_event",
            status: "confirmed",
            start: { dateTime: range.start },
            end: { dateTime: range.end },
          },
        ],
      },
    }),
  });
  await assert.rejects(
    conflict.adapter.rescheduleAppointment(
      context,
      appointmentReferences,
      "moving_event",
      range,
    ),
    GoogleCalendarConflictError,
  );

  let patched = false;
  const available = setup({
    listEvents: async () => ({
      data: {
        items: [
          {
            id: "moving_event",
            status: "confirmed",
            start: { dateTime: range.start },
            end: { dateTime: range.end },
          },
        ],
      },
    }),
    patchEvent: async () => {
      patched = true;
      return { data: { id: "moving_event", htmlLink: null } };
    },
  });
  await available.adapter.rescheduleAppointment(
    context,
    appointmentReferences,
    "moving_event",
    range,
  );
  assert.equal(patched, true);
});

test("treats timezone-aware all-day events as rescheduling conflicts", async () => {
  const { adapter } = setup({
    listEvents: async () => ({
      data: {
        items: [
          {
            id: "all_day_event",
            status: "confirmed",
            start: { date: "2026-10-19", timeZone: "America/New_York" },
            end: { date: "2026-10-20", timeZone: "America/New_York" },
          },
        ],
      },
    }),
  });

  await assert.rejects(
    adapter.rescheduleAppointment(
      context,
      appointmentReferences,
      "moving_event",
      range,
    ),
    GoogleCalendarConflictError,
  );
});

test("cancels provider event and clears its CRM event link", async () => {
  let deletedEventId = "";
  const { adapter, appointmentLinkStore } = setup({
    deleteEvent: async (request) => {
      deletedEventId = request.eventId;
      return { data: {} };
    },
  });
  await adapter.cancelAppointment(
    context,
    appointmentReferences,
    "google_event_1",
  );
  assert.equal(deletedEventId, "google_event_1");
  assert.equal(appointmentLinkStore.cleared, true);
});

test("surfaces provider failures without leaking provider response details", async () => {
  const { adapter } = setup({
    freeBusy: async () => {
      throw Object.assign(new Error("private response content"), {
        response: { status: 503, data: "private details" },
      });
    },
  });

  await assert.rejects(
    adapter.getFreeBusy(context, range),
    (error: Error) => {
      assert.ok(error instanceof GoogleCalendarProviderError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.message.includes("private"), false);
      return true;
    },
  );
});

test("disconnect revokes Google credentials and removes stored tokens", async () => {
  const { adapter, connectionStore, provider } = setup();
  await adapter.disconnect(context);
  assert.equal(provider.revoked, true);
  assert.equal(connectionStore.deleted, true);
  assert.deepEqual(connectionStore.statuses, ["disconnected"]);
});

test("validates environment configuration and required CRM references", async () => {
  const dependencies = {
    oauthStateStore: new StateStore(),
    connectionStore: new ConnectionStore(),
    appointmentLinkStore: new AppointmentLinkStore(),
  };
  assert.throws(
    () => createGoogleCalendarAdapterFromEnvironment({}, dependencies),
    /GOOGLE_CALENDAR_CLIENT_ID/,
  );
  assert.doesNotThrow(() =>
    createGoogleCalendarAdapterFromEnvironment(
      {
        GOOGLE_CALENDAR_CLIENT_ID: "client-id",
        GOOGLE_CALENDAR_CLIENT_SECRET: "client-secret",
        GOOGLE_CALENDAR_REDIRECT_URI: "https://app.example.test/oauth/google/callback",
      },
      dependencies,
    ),
  );
  const { adapter } = setup();
  await assert.rejects(
    adapter.createAppointment(context, { appointmentId: "" }, appointment),
    TypeError,
  );
});
