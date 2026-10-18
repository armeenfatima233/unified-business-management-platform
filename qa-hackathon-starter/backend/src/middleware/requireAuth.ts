// Authentication middleware (F1.6, Q2). The workspace and user come ONLY from the
// server-side session. No route may read a workspace id from the request body,
// query or headers (AGENTS.md: never trust client-supplied tenant context).
import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db.ts";
import { lookupSession, SESSION_COOKIE, type SessionInfo } from "../auth/sessions.ts";

declare module "express-serve-static-core" {
  interface Request {
    session?: SessionInfo;
  }
}

export const apiError = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message } }); // shape from API_CONTRACT.md

export function requireAuth(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const session = typeof token === "string" ? lookupSession(db, token) : null;
    if (!session) return apiError(res, 401, "UNAUTHENTICATED", "Please log in.");
    req.session = session;
    next();
  };
}
