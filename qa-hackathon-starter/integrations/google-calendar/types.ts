import type { Credentials } from "google-auth-library";

export interface GoogleCalendarMemberContext {
  workspaceId: string;
  memberId: string;
}

export interface GoogleCalendarOAuthStateStore {
  /**
   * Store a state hash with a TTL; consume must atomically return-and-delete
   * only an unexpired entry.
   */
  create(
    stateHash: string,
    context: GoogleCalendarMemberContext,
    sessionBindingHash: string,
    expiresAt: Date,
  ): Promise<void>;
  consume(
    stateHash: string,
    sessionBindingHash: string,
  ): Promise<GoogleCalendarMemberContext | null>;
}

export type GoogleCalendarConnectionStatus =
  | "connected"
  | "revoked"
  | "reauthorization_required"
  | "disconnected";

export interface GoogleCalendarConnectionStore {
  getCredentials(
    context: GoogleCalendarMemberContext,
  ): Promise<Credentials | null>;
  saveCredentials(
    context: GoogleCalendarMemberContext,
    credentials: Credentials,
  ): Promise<void>;
  setStatus(
    context: GoogleCalendarMemberContext,
    status: GoogleCalendarConnectionStatus,
  ): Promise<void>;
  deleteCredentials(
    context: GoogleCalendarMemberContext,
  ): Promise<void>;
}

export interface GoogleCalendarTimeRange {
  start: string;
  end: string;
  timeZone: string;
}

export interface GoogleCalendarAppointmentInput extends GoogleCalendarTimeRange {
  summary: string;
  description?: string;
  location?: string;
}

export interface GoogleCalendarAppointmentReferences {
  appointmentId: string;
  contactId?: string;
  opportunityId?: string;
}

export interface GoogleCalendarEventReference {
  eventId: string;
  htmlLink: string | null;
}

export interface GoogleCalendarBusyPeriod {
  start: string;
  end: string;
}

export interface GoogleCalendarCrmContextResolver {
  /**
   * Implementations must resolve workspace/member from the authenticated
   * server session and never trust IDs supplied by a browser.
   */
  resolveMemberContext(
    authenticatedActorId: string,
  ): Promise<GoogleCalendarMemberContext>;
}

export interface GoogleCalendarAppointmentLinkStore {
  /**
   * Persist the returned Google event ID against the already-authorized CRM
   * appointment. The adapter itself has no CRM persistence or schema.
   */
  setGoogleEventId(
    context: GoogleCalendarMemberContext,
    references: GoogleCalendarAppointmentReferences,
    eventId: string,
  ): Promise<void>;
  clearGoogleEventId(
    context: GoogleCalendarMemberContext,
    references: GoogleCalendarAppointmentReferences,
  ): Promise<void>;
}
