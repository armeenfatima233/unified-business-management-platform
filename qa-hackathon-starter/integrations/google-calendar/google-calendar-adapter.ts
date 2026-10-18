import { createHash, randomBytes } from "node:crypto";
import { google, type calendar_v3 } from "googleapis";
import { OAuth2Client, type Credentials } from "google-auth-library";
import type {
  GoogleCalendarAppointmentInput,
  GoogleCalendarAppointmentLinkStore,
  GoogleCalendarAppointmentReferences,
  GoogleCalendarBusyPeriod,
  GoogleCalendarConnectionStore,
  GoogleCalendarEventReference,
  GoogleCalendarMemberContext,
  GoogleCalendarOAuthStateStore,
  GoogleCalendarTimeRange,
} from "./types.ts";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
];

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const DEFAULT_CALENDAR_ID = "primary";

interface GoogleOAuthClient {
  generateAuthUrl(options: {
    access_type: "offline";
    include_granted_scopes: true;
    prompt: "consent";
    redirect_uri: string;
    scope: string[];
    state: string;
  }): string;
  getToken(code: string): Promise<{ tokens: Credentials }>;
  setCredentials(credentials: Credentials): void;
  refreshAccessToken(): Promise<{ credentials: Credentials }>;
  revokeCredentials(): Promise<unknown>;
}

interface ApiResponse<T> {
  data: T;
}

interface CalendarApi {
  queryFreeBusy(request: {
    requestBody: {
      timeMin: string;
      timeMax: string;
      timeZone: string;
      items: Array<{ id: string }>;
    };
  }): Promise<ApiResponse<calendar_v3.Schema$FreeBusyResponse>>;
  listEvents(request: {
    calendarId: string;
    timeMin: string;
    timeMax: string;
    singleEvents: true;
    orderBy: "startTime";
  }): Promise<ApiResponse<calendar_v3.Schema$Events>>;
  insertEvent(request: {
    calendarId: string;
    requestBody: calendar_v3.Schema$Event;
  }): Promise<ApiResponse<calendar_v3.Schema$Event>>;
  patchEvent(request: {
    calendarId: string;
    eventId: string;
    requestBody: calendar_v3.Schema$Event;
  }): Promise<ApiResponse<calendar_v3.Schema$Event>>;
  deleteEvent(request: { calendarId: string; eventId: string }): Promise<unknown>;
}

export interface GoogleCalendarSdk {
  createOAuthClient(options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): GoogleOAuthClient;
  createCalendarApi(auth: GoogleOAuthClient): CalendarApi;
}

export interface GoogleCalendarConfiguration {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleCalendarEnvironment {
  GOOGLE_CALENDAR_CLIENT_ID?: string;
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;
  GOOGLE_CALENDAR_REDIRECT_URI?: string;
}

export class GoogleCalendarOAuthStateError extends Error {
  constructor() {
    super("Google Calendar OAuth state is invalid or expired");
    this.name = "GoogleCalendarOAuthStateError";
  }
}

export class GoogleCalendarOAuthError extends Error {
  constructor() {
    super("Google Calendar authorization could not be completed");
    this.name = "GoogleCalendarOAuthError";
  }
}

export class GoogleCalendarLinkPersistenceError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super("Google Calendar changed, but the CRM event link could not be saved");
    this.name = "GoogleCalendarLinkPersistenceError";
    this.eventId = eventId;
  }
}

export class GoogleCalendarConnectionError extends Error {
  constructor() {
    super("Google Calendar connection is unavailable");
    this.name = "GoogleCalendarConnectionError";
  }
}

export class GoogleCalendarRevokedError extends Error {
  constructor() {
    super("Google Calendar authorization was revoked; reconnect the account");
    this.name = "GoogleCalendarRevokedError";
  }
}

export class GoogleCalendarProviderError extends Error {
  readonly statusCode: number | null;

  constructor(statusCode: number | null = null) {
    super("Google Calendar request failed");
    this.name = "GoogleCalendarProviderError";
    this.statusCode = statusCode;
  }
}

export class GoogleCalendarConflictError extends Error {
  constructor() {
    super("The requested time conflicts with an existing calendar event");
    this.name = "GoogleCalendarConflictError";
  }
}

function createOfficialGoogleSdk(): GoogleCalendarSdk {
  return {
    createOAuthClient: ({ clientId, clientSecret, redirectUri }) =>
      new google.auth.OAuth2(clientId, clientSecret, redirectUri),
    createCalendarApi: (auth) => {
      const calendar = google.calendar({
        version: "v3",
        auth: auth as OAuth2Client,
      });
      return {
        queryFreeBusy: async (request) => calendar.freebusy.query(request),
        listEvents: async (request) => calendar.events.list(request),
        insertEvent: async (request) => calendar.events.insert(request),
        patchEvent: async (request) => calendar.events.patch(request),
        deleteEvent: async (request) => calendar.events.delete(request),
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStatusCode(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const response = error.response;
  if (isRecord(response) && typeof response.status === "number") {
    return response.status;
  }
  return typeof error.code === "number" ? error.code : null;
}

function isInvalidGrant(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const response = error.response;
  const data = isRecord(response) ? response.data : undefined;
  return (
    error.message === "invalid_grant" ||
    (isRecord(data) && data.error === "invalid_grant")
  );
}

function validateTimeRange(range: GoogleCalendarTimeRange): void {
  const isOffsetDateTime = (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    );
  const startMs = Date.parse(range.start);
  const endMs = Date.parse(range.end);
  if (
    !isOffsetDateTime(range.start) ||
    !isOffsetDateTime(range.end) ||
    Number.isNaN(startMs) ||
    Number.isNaN(endMs) ||
    startMs >= endMs
  ) {
    throw new TypeError("Calendar times must be ordered RFC 3339 timestamps with offsets");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: range.timeZone });
  } catch {
    throw new TypeError("A valid IANA time zone is required");
  }
}

function overlaps(
  firstStart: string,
  firstEnd: string,
  secondStart: string,
  secondEnd: string,
): boolean {
  const firstStartMs = Date.parse(firstStart);
  const firstEndMs = Date.parse(firstEnd);
  const secondStartMs = Date.parse(secondStart);
  const secondEndMs = Date.parse(secondEnd);
  return firstStartMs < secondEndMs && secondStartMs < firstEndMs;
}

function dateOnlyToInstant(date: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new GoogleCalendarProviderError();
  }
  const targetUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  let estimate = targetUtc;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(estimate))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const renderedUtc = Date.UTC(
      parts.year ?? 0,
      (parts.month ?? 1) - 1,
      parts.day ?? 1,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
    );
    estimate -= renderedUtc - targetUtc;
  }
  return new Date(estimate).toISOString();
}

function eventDateTime(
  value:
    | calendar_v3.Schema$EventDateTime
    | null
    | undefined,
  fallbackTimeZone: string,
): string | null {
  if (!value) {
    return null;
  }
  if (value.dateTime) {
    return value.dateTime;
  }
  if (value.date) {
    return dateOnlyToInstant(value.date, value.timeZone ?? fallbackTimeZone);
  }
  return null;
}

function asCredentials(
  stored: Credentials | null,
): Credentials {
  if (stored === null || !stored.refresh_token) {
    throw new GoogleCalendarConnectionError();
  }
  return stored;
}

export class GoogleCalendarAdapter {
  private readonly sdk: GoogleCalendarSdk;
  private readonly configuration: GoogleCalendarConfiguration;
  private readonly oauthStateStore: GoogleCalendarOAuthStateStore;
  private readonly connectionStore: GoogleCalendarConnectionStore;
  private readonly appointmentLinkStore: GoogleCalendarAppointmentLinkStore;
  private readonly now: () => number;

  constructor(options: {
    configuration: GoogleCalendarConfiguration;
    oauthStateStore: GoogleCalendarOAuthStateStore;
    connectionStore: GoogleCalendarConnectionStore;
    appointmentLinkStore: GoogleCalendarAppointmentLinkStore;
    sdk?: GoogleCalendarSdk;
    now?: () => number;
  }) {
    if (
      !options.configuration.clientId ||
      !options.configuration.clientSecret ||
      !options.configuration.redirectUri
    ) {
      throw new TypeError("Google Calendar OAuth configuration is incomplete");
    }
    this.configuration = options.configuration;
    this.oauthStateStore = options.oauthStateStore;
    this.connectionStore = options.connectionStore;
    this.appointmentLinkStore = options.appointmentLinkStore;
    this.sdk = options.sdk ?? createOfficialGoogleSdk();
    this.now = options.now ?? Date.now;
  }

  async createAuthorizationUrl(
    context: GoogleCalendarMemberContext,
    sessionBinding: string,
  ): Promise<string> {
    if (!sessionBinding) {
      throw new TypeError("An authenticated session binding is required");
    }
    const state = randomBytes(32).toString("base64url");
    const stateHash = createHash("sha256").update(state).digest("hex");
    const sessionBindingHash = createHash("sha256")
      .update(sessionBinding)
      .digest("hex");
    await this.oauthStateStore.create(
      stateHash,
      context,
      sessionBindingHash,
      new Date(this.now() + OAUTH_STATE_TTL_MS),
    );
    return this.createOAuthClient().generateAuthUrl({
      access_type: "offline",
      include_granted_scopes: true,
      prompt: "consent",
      redirect_uri: this.configuration.redirectUri,
      scope: [...GOOGLE_CALENDAR_SCOPES],
      state,
    });
  }

  async completeAuthorization(
    code: string,
    state: string,
    sessionBinding: string,
  ): Promise<GoogleCalendarMemberContext> {
    if (!code || !state || !sessionBinding) {
      throw new GoogleCalendarOAuthStateError();
    }
    const stateHash = createHash("sha256").update(state).digest("hex");
    const sessionBindingHash = createHash("sha256")
      .update(sessionBinding)
      .digest("hex");
    const context = await this.oauthStateStore.consume(
      stateHash,
      sessionBindingHash,
    );
    if (context === null) {
      throw new GoogleCalendarOAuthStateError();
    }

    const client = this.createOAuthClient();
    let tokens: Credentials;
    try {
      ({ tokens } = await client.getToken(code));
    } catch {
      throw new GoogleCalendarOAuthError();
    }
    const existing = await this.connectionStore.getCredentials(context);
    const credentials: Credentials = {
      ...existing,
      ...tokens,
      refresh_token: tokens.refresh_token ?? existing?.refresh_token ?? null,
    };
    if (!credentials.access_token || !credentials.refresh_token) {
      await this.connectionStore.setStatus(context, "reauthorization_required");
      throw new GoogleCalendarOAuthError();
    }
    await this.connectionStore.saveCredentials(context, credentials);
    await this.connectionStore.setStatus(context, "connected");
    return context;
  }

  async getFreeBusy(
    context: GoogleCalendarMemberContext,
    range: GoogleCalendarTimeRange,
  ): Promise<GoogleCalendarBusyPeriod[]> {
    validateTimeRange(range);
    return this.withCalendar(context, async (api) => {
      const response = await api.queryFreeBusy({
        requestBody: {
          timeMin: range.start,
          timeMax: range.end,
          timeZone: range.timeZone,
          items: [{ id: DEFAULT_CALENDAR_ID }],
        },
      });
      const calendar = response.data.calendars?.[DEFAULT_CALENDAR_ID];
      if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy)) {
        throw new GoogleCalendarProviderError();
      }
      return calendar.busy.map((period) => {
        if (!period.start || !period.end) {
          throw new GoogleCalendarProviderError();
        }
        const start = Date.parse(period.start);
        const end = Date.parse(period.end);
        if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
          throw new GoogleCalendarProviderError();
        }
        return { start: period.start, end: period.end };
      });
    });
  }

  async createAppointment(
    context: GoogleCalendarMemberContext,
    references: GoogleCalendarAppointmentReferences,
    appointment: GoogleCalendarAppointmentInput,
  ): Promise<GoogleCalendarEventReference> {
    this.validateAppointment(references, appointment);
    const busy = await this.getFreeBusy(context, appointment);
    if (
      busy.some((period) =>
        overlaps(appointment.start, appointment.end, period.start, period.end),
      )
    ) {
      throw new GoogleCalendarConflictError();
    }

    return this.withCalendar(context, async (api) => {
      const response = await api.insertEvent({
        calendarId: DEFAULT_CALENDAR_ID,
        requestBody: this.eventBody(appointment),
      });
      if (!response.data.id) {
        throw new GoogleCalendarProviderError();
      }
      try {
        await this.appointmentLinkStore.setGoogleEventId(
          context,
          references,
          response.data.id,
        );
      } catch {
        throw new GoogleCalendarLinkPersistenceError(response.data.id);
      }
      return {
        eventId: response.data.id,
        htmlLink: response.data.htmlLink ?? null,
      };
    });
  }

  async rescheduleAppointment(
    context: GoogleCalendarMemberContext,
    references: GoogleCalendarAppointmentReferences,
    eventId: string,
    range: GoogleCalendarTimeRange,
  ): Promise<GoogleCalendarEventReference> {
    if (!eventId) {
      throw new TypeError("A Google Calendar event ID is required");
    }
    this.validateReferences(references);
    validateTimeRange(range);

    return this.withCalendar(context, async (api) => {
      const events = await api.listEvents({
        calendarId: DEFAULT_CALENDAR_ID,
        timeMin: range.start,
        timeMax: range.end,
        singleEvents: true,
        orderBy: "startTime",
      });
      const conflict = (events.data.items ?? []).some((event) => {
        if (!event.id || event.id === eventId || event.status === "cancelled") {
          return false;
        }
        const eventStart = event.start
          ? eventDateTime(event.start, range.timeZone)
          : null;
        const eventEnd = event.end
          ? eventDateTime(event.end, range.timeZone)
          : null;
        if (!eventStart || !eventEnd) {
          return false;
        }
        return overlaps(
          range.start,
          range.end,
          eventStart,
          eventEnd,
        );
      });
      if (conflict) {
        throw new GoogleCalendarConflictError();
      }

      const response = await api.patchEvent({
        calendarId: DEFAULT_CALENDAR_ID,
        eventId,
        requestBody: {
          start: { dateTime: range.start, timeZone: range.timeZone },
          end: { dateTime: range.end, timeZone: range.timeZone },
        },
      });
      if (!response.data.id) {
        throw new GoogleCalendarProviderError();
      }
      try {
        await this.appointmentLinkStore.setGoogleEventId(
          context,
          references,
          response.data.id,
        );
      } catch {
        throw new GoogleCalendarLinkPersistenceError(response.data.id);
      }
      return {
        eventId: response.data.id,
        htmlLink: response.data.htmlLink ?? null,
      };
    });
  }

  async cancelAppointment(
    context: GoogleCalendarMemberContext,
    references: GoogleCalendarAppointmentReferences,
    eventId: string,
  ): Promise<void> {
    if (!eventId) {
      throw new TypeError("A Google Calendar event ID is required");
    }
    this.validateReferences(references);
    await this.withCalendar(context, async (api) => {
      await api.deleteEvent({ calendarId: DEFAULT_CALENDAR_ID, eventId });
      try {
        await this.appointmentLinkStore.clearGoogleEventId(context, references);
      } catch {
        throw new GoogleCalendarLinkPersistenceError(eventId);
      }
    });
  }

  async disconnect(context: GoogleCalendarMemberContext): Promise<void> {
    const credentials = await this.connectionStore.getCredentials(context);
    if (credentials === null) {
      await this.connectionStore.setStatus(context, "disconnected");
      return;
    }
    const client = this.createOAuthClient();
    client.setCredentials(credentials);
    try {
      await client.revokeCredentials();
    } catch (error) {
      if (getStatusCode(error) !== 400 && getStatusCode(error) !== 401) {
        throw new GoogleCalendarProviderError(getStatusCode(error));
      }
    }
    await this.connectionStore.deleteCredentials(context);
    await this.connectionStore.setStatus(context, "disconnected");
  }

  private createOAuthClient(): GoogleOAuthClient {
    return this.sdk.createOAuthClient(this.configuration);
  }

  private validateReferences(
    references: GoogleCalendarAppointmentReferences,
  ): void {
    if (!references.appointmentId) {
      throw new TypeError("A CRM appointment ID is required");
    }
  }

  private validateAppointment(
    references: GoogleCalendarAppointmentReferences,
    appointment: GoogleCalendarAppointmentInput,
  ): void {
    this.validateReferences(references);
    validateTimeRange(appointment);
    if (!appointment.summary.trim()) {
      throw new TypeError("An appointment summary is required");
    }
  }

  private eventBody(
    appointment: GoogleCalendarAppointmentInput,
  ): calendar_v3.Schema$Event {
    return {
      summary: appointment.summary,
      ...(appointment.description !== undefined
        ? { description: appointment.description }
        : {}),
      ...(appointment.location !== undefined
        ? { location: appointment.location }
        : {}),
      start: {
        dateTime: appointment.start,
        timeZone: appointment.timeZone,
      },
      end: {
        dateTime: appointment.end,
        timeZone: appointment.timeZone,
      },
    };
  }

  private async withCalendar<T>(
    context: GoogleCalendarMemberContext,
    operation: (api: CalendarApi) => Promise<T>,
  ): Promise<T> {
    const credentials = asCredentials(
      await this.connectionStore.getCredentials(context),
    );
    const client = this.createOAuthClient();
    client.setCredentials(credentials);
    await this.refreshIfNeeded(context, client, credentials);

    const api = this.sdk.createCalendarApi(client);
    try {
      return await operation(api);
    } catch (error) {
      if (getStatusCode(error) === 401) {
        try {
          const refreshed = await this.refreshCredentials(context, client, credentials);
          client.setCredentials(refreshed);
          return await operation(this.sdk.createCalendarApi(client));
        } catch (refreshError) {
          if (isInvalidGrant(refreshError)) {
            await this.connectionStore.setStatus(context, "revoked");
            throw new GoogleCalendarRevokedError();
          }
          if (getStatusCode(refreshError) === 401) {
            await this.connectionStore.setStatus(context, "revoked");
            throw new GoogleCalendarRevokedError();
          }
          if (refreshError instanceof GoogleCalendarRevokedError) {
            throw refreshError;
          }
          throw new GoogleCalendarProviderError(getStatusCode(refreshError));
        }
      }
      if (isInvalidGrant(error)) {
        await this.connectionStore.setStatus(context, "revoked");
        throw new GoogleCalendarRevokedError();
      }
      if (error instanceof GoogleCalendarConflictError) {
        throw error;
      }
      if (error instanceof GoogleCalendarLinkPersistenceError) {
        throw error;
      }
      if (error instanceof TypeError) {
        throw error;
      }
      throw new GoogleCalendarProviderError(getStatusCode(error));
    }
  }

  private async refreshIfNeeded(
    context: GoogleCalendarMemberContext,
    client: GoogleOAuthClient,
    current: Credentials,
  ): Promise<void> {
    if (
      current.access_token &&
      current.expiry_date !== null &&
      current.expiry_date !== undefined &&
      current.expiry_date > this.now() + TOKEN_REFRESH_BUFFER_MS
    ) {
      return;
    }
    await this.refreshCredentials(context, client, current);
  }

  private async refreshCredentials(
    context: GoogleCalendarMemberContext,
    client: GoogleOAuthClient,
    current: Credentials,
  ): Promise<Credentials> {
    try {
      const { credentials } = await client.refreshAccessToken();
      const refreshed: Credentials = {
        ...current,
        ...credentials,
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token ?? current.refresh_token,
      };
      if (!refreshed.access_token || !refreshed.refresh_token) {
        await this.connectionStore.setStatus(
          context,
          "reauthorization_required",
        );
        throw new GoogleCalendarConnectionError();
      }
      await this.connectionStore.saveCredentials(context, refreshed);
      await this.connectionStore.setStatus(context, "connected");
      client.setCredentials(refreshed);
      return refreshed;
    } catch (error) {
      if (error instanceof GoogleCalendarConnectionError) {
        throw error;
      }
      if (isInvalidGrant(error)) {
        await this.connectionStore.setStatus(context, "revoked");
        throw new GoogleCalendarRevokedError();
      }
      throw new GoogleCalendarProviderError(getStatusCode(error));
    }
  }
}

export function createGoogleCalendarAdapterFromEnvironment(
  environment: GoogleCalendarEnvironment = process.env,
  dependencies: {
    oauthStateStore: GoogleCalendarOAuthStateStore;
    connectionStore: GoogleCalendarConnectionStore;
    appointmentLinkStore: GoogleCalendarAppointmentLinkStore;
  },
): GoogleCalendarAdapter {
  const clientId = environment.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = environment.GOOGLE_CALENDAR_CLIENT_SECRET;
  const redirectUri = environment.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new TypeError(
      "GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, and GOOGLE_CALENDAR_REDIRECT_URI are required",
    );
  }
  return new GoogleCalendarAdapter({
    configuration: { clientId, clientSecret, redirectUri },
    ...dependencies,
  });
}
