// Minimal CORS for the separate frontend origin (cookie auth needs credentials).
// Only origins listed in CORS_ORIGINS (comma-separated) are echoed back; never "*".
import type { NextFunction, Request, Response } from "express";

export function cors(allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") return void res.status(204).end();
    next();
  };
}

// Defence in depth against cross-site request forgery (Q3), on top of SameSite=Lax cookies: a
// state-changing browser request that names a foreign Origin is refused. Requests with no Origin
// (provider webhooks, curl, tests) are unaffected because they do not carry ambient cookies.
export function csrfGuard(allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const origin = req.headers.origin;
    if (unsafe && origin && !allowed.includes(origin) && origin !== `${req.protocol}://${req.headers.host}`) {
      return void res.status(403).json({ error: { code: "CSRF_BLOCKED", message: "This request came from an origin that is not allowed." } });
    }
    next();
  };
}

// Baseline response headers for an API: no sniffing, no framing, no referrer leakage, no caching of private data.
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
}
