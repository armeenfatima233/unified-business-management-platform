import { Router } from "express";
import {
  GoogleCalendarAdapter,
  GoogleCalendarOAuthError,
  GoogleCalendarOAuthStateError,
  type GoogleCalendarConfiguration,
  type GoogleCalendarSdk,
} from "../../../integrations/google-calendar/google-calendar-adapter.ts";
import type {
  GoogleCalendarCredentials,
  GoogleCalendarConnectionStatus,
  GoogleCalendarMemberContext,
} from "../../../integrations/google-calendar/types.ts";
import { SESSION_COOKIE } from "../auth/sessions.ts";
import {
  connectionConfig,
  connectionSecrets,
  getConnection,
  saveConnection,
  type IntegrationContext,
} from "./core.ts";
import { tx } from "../db.ts";
import { apiError, requireAuth } from "../middleware/requireAuth.ts";
import { loadMember } from "../middleware/requirePermission.ts";

export interface GoogleCalendarEnvironment {
  GOOGLE_CALENDAR_CLIENT_ID?: string;
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;
  GOOGLE_CALENDAR_REDIRECT_URI?: string;
}

export function oauthConfiguration(
  environment: GoogleCalendarEnvironment,
): GoogleCalendarConfiguration {
  const clientId = environment.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  const clientSecret = environment.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  const redirectUri = environment.GOOGLE_CALENDAR_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new TypeError("Google Calendar OAuth configuration is incomplete");
  }
  return { clientId, clientSecret, redirectUri };
}

type GoogleOAuthResult = "connected" | "denied" | "error";

function frontendResultRedirect(
  frontendUrl: string,
  result: GoogleOAuthResult,
): string {
  const target = new URL(frontendUrl);
  const isLocalHttp =
    target.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if (
    (target.protocol !== "https:" && !isLocalHttp) ||
    target.username.length > 0 ||
    target.password.length > 0
  ) {
    throw new TypeError("FRONTEND_URL must be a trusted HTTPS URL");
  }
  target.searchParams.set("google", result);
  return target.toString();
}

export function memberContext(
  workspaceId: string,
  memberId: string,
): GoogleCalendarMemberContext {
  return { workspaceId, memberId };
}

export function googleCalendarAdapter(
  ctx: IntegrationContext,
  configuration: GoogleCalendarConfiguration,
  sdk?: GoogleCalendarSdk,
): GoogleCalendarAdapter {
  return new GoogleCalendarAdapter({
    configuration,
    ...(sdk ? { sdk } : {}),
    oauthStateStore: {
      async create(stateHash, context, sessionBindingHash, expiresAt) {
        const stateKey = `${stateHash}.${sessionBindingHash}`;
        tx(ctx.db, () => {
          ctx.db
            .prepare("DELETE FROM oauth_states WHERE expires_at <= ?")
            .run(new Date().toISOString());
          ctx.db
            .prepare(
              "INSERT INTO oauth_states (state, workspace_id, user_id, expires_at) VALUES (?,?,?,?)",
            )
            .run(
              stateKey,
              context.workspaceId,
              context.memberId,
              expiresAt.toISOString(),
            );
        });
      },
      async consume(stateHash, sessionBindingHash) {
        const stateKey = `${stateHash}.${sessionBindingHash}`;
        return tx(ctx.db, () => {
          const row = ctx.db
            .prepare(
              "SELECT workspace_id, user_id, expires_at FROM oauth_states WHERE state = ?",
            )
            .get(stateKey) as
            | {
                workspace_id: string;
                user_id: string;
                expires_at: string;
              }
            | undefined;
          if (!row) return null;
          ctx.db
            .prepare("DELETE FROM oauth_states WHERE state = ?")
            .run(stateKey);
          if (new Date(row.expires_at).getTime() <= Date.now()) return null;
          return memberContext(row.workspace_id, row.user_id);
        });
      },
    },
    connectionStore: {
      async getCredentials(context) {
        const connection = getConnection(
          ctx.db,
          context.workspaceId,
          "google",
          context.memberId,
        );
        return connection
          ? connectionSecrets<GoogleCalendarCredentials>(ctx, connection)
          : null;
      },
      async saveCredentials(context, credentials) {
        const existing = getConnection(
          ctx.db,
          context.workspaceId,
          "google",
          context.memberId,
        );
        const config = existing
          ? connectionConfig<Record<string, unknown>>(existing)
          : {};
        saveConnection(
          ctx,
          context.workspaceId,
          "google",
          context.memberId,
          config,
          credentials,
        );
      },
      async setStatus(context, status: GoogleCalendarConnectionStatus) {
        const connection = getConnection(
          ctx.db,
          context.workspaceId,
          "google",
          context.memberId,
        );
        if (!connection) return;
        const persistedStatus =
          status === "connected"
            ? "connected"
            : status === "disconnected"
              ? "error"
              : "needs_reconnection";
        const reason =
          status === "revoked"
            ? "Google access was revoked or expired. Reconnect Google Calendar."
            : status === "reauthorization_required"
              ? "Google did not return a refresh token. Reconnect Google Calendar and approve access again."
              : null;
        ctx.db
          .prepare(
            "UPDATE integration_connections SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
          )
          .run(persistedStatus, reason, new Date().toISOString(), connection.id);
      },
      async deleteCredentials(context) {
        const connection = getConnection(
          ctx.db,
          context.workspaceId,
          "google",
          context.memberId,
        );
        if (!connection) return;
        ctx.db
          .prepare(
            "UPDATE integration_connections SET secrets_enc = NULL, status = 'error', updated_at = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), connection.id);
      },
    },
    appointmentLinkStore: {
      async setGoogleEventId(context, references, eventId) {
        tx(ctx.db, () => {
          const appointment = ctx.db
            .prepare(
              `SELECT contact_id, opportunity_id FROM appointments
               WHERE id = ? AND workspace_id = ? AND user_id = ?`,
            )
            .get(
              references.appointmentId,
              context.workspaceId,
              context.memberId,
            ) as
            | { contact_id: string; opportunity_id: string | null }
            | undefined;
          if (
            !appointment ||
            (references.contactId !== undefined &&
              appointment.contact_id !== references.contactId) ||
            (references.opportunityId !== undefined &&
              appointment.opportunity_id !== references.opportunityId)
          ) {
            throw new Error("Google Calendar appointment is not authorized");
          }
          ctx.db
            .prepare(
              "UPDATE appointments SET google_event_id = ? WHERE id = ? AND workspace_id = ? AND user_id = ?",
            )
            .run(
              eventId,
              references.appointmentId,
              context.workspaceId,
              context.memberId,
            );
        });
      },
      async clearGoogleEventId(context, references) {
        tx(ctx.db, () => {
          const appointment = ctx.db
            .prepare(
              `SELECT contact_id, opportunity_id FROM appointments
               WHERE id = ? AND workspace_id = ? AND user_id = ?`,
            )
            .get(
              references.appointmentId,
              context.workspaceId,
              context.memberId,
            ) as
            | { contact_id: string; opportunity_id: string | null }
            | undefined;
          if (
            !appointment ||
            (references.contactId !== undefined &&
              appointment.contact_id !== references.contactId) ||
            (references.opportunityId !== undefined &&
              appointment.opportunity_id !== references.opportunityId)
          ) {
            throw new Error("Google Calendar appointment is not authorized");
          }
          ctx.db
            .prepare(
              "UPDATE appointments SET google_event_id = NULL WHERE id = ? AND workspace_id = ? AND user_id = ?",
            )
            .run(
              references.appointmentId,
              context.workspaceId,
              context.memberId,
            );
        });
      },
    },
  });
}

export function googleCalendarOAuthRouter(
  ctx: IntegrationContext,
  environment: GoogleCalendarEnvironment = process.env,
  sdk?: GoogleCalendarSdk,
) {
  const router = Router();
  router.use(requireAuth(ctx.db), loadMember(ctx.db));

  router.get("/oauth/start", async (req, res) => {
    const sessionBinding = req.cookies?.[SESSION_COOKIE];
    if (typeof sessionBinding !== "string" || sessionBinding.length === 0) {
      return apiError(res, 401, "UNAUTHENTICATED", "Please log in.");
    }
    let configuration: GoogleCalendarConfiguration;
    try {
      configuration = oauthConfiguration(environment);
    } catch {
      return apiError(
        res,
        503,
        "GOOGLE_CALENDAR_UNAVAILABLE",
        "Google Calendar OAuth is not configured.",
      );
    }
    const adapter = googleCalendarAdapter(ctx, configuration, sdk);
    const authorizationUrl = await adapter.createAuthorizationUrl(
      memberContext(req.session!.workspaceId, req.session!.userId),
      sessionBinding,
    );
    res.json({ authorizationUrl });
  });

  router.get("/oauth/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const providerError =
      typeof req.query.error === "string" ? req.query.error : "";
    const sessionBinding = req.cookies?.[SESSION_COOKIE];
    if (typeof sessionBinding !== "string" || sessionBinding.length === 0) {
      return apiError(res, 401, "UNAUTHENTICATED", "Please log in.");
    }
    try {
      const adapter = googleCalendarAdapter(
        ctx,
        oauthConfiguration(environment),
        sdk,
      );
      if (providerError || !code) {
        const denied = providerError === "access_denied";
        const stateContext = await adapter.validateAuthorizationState(
          state,
          sessionBinding,
        );
        if (
          stateContext.workspaceId !== req.session!.workspaceId ||
          stateContext.memberId !== req.session!.userId
        ) {
          return apiError(res, 400, "INVALID_OAUTH_STATE", "OAuth state is invalid or expired.");
        }
        return res.redirect(
          302,
          frontendResultRedirect(
            ctx.frontendUrl,
            denied ? "denied" : "error",
          ),
        );
      }
      const connectedMember = await adapter.completeAuthorization(
        code,
        state,
        sessionBinding,
      );
      if (
        connectedMember.workspaceId !== req.session!.workspaceId ||
        connectedMember.memberId !== req.session!.userId
      ) {
        return apiError(res, 400, "INVALID_OAUTH_STATE", "OAuth state is invalid or expired.");
      }
      return res.redirect(
        302,
        frontendResultRedirect(ctx.frontendUrl, "connected"),
      );
    } catch (error) {
      if (error instanceof GoogleCalendarOAuthStateError) {
        return apiError(res, 400, "INVALID_OAUTH_STATE", "OAuth state is invalid or expired.");
      }
      if (error instanceof GoogleCalendarOAuthError) {
        return res.redirect(
          302,
          frontendResultRedirect(ctx.frontendUrl, "error"),
        );
      }
      console.error("Google Calendar OAuth callback failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return res.redirect(
        302,
        frontendResultRedirect(ctx.frontendUrl, "error"),
      );
    }
  });

  return router;
}
