// Small request helpers shared by the routers.
import { z } from "zod";
import type { Response } from "express";

// Server-side pagination (Q9). pageSize is capped so one request can never dump a table.
export function paginate(query: Record<string, unknown>, maxPageSize = 100) {
  const page = Math.max(1, Number.parseInt(String(query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number.parseInt(String(query.pageSize ?? "25"), 10) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// Normalises a phone number to "+digits" so provider senders match stored contacts (I1.5).
// Numbers without a country code are kept as digits only; the doc states the format rule.
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/^whatsapp:/i, "").trim();
  const digits = stripped.replace(/[^\d]/g, "");
  if (digits.length < 5) return null;
  return stripped.startsWith("+") || stripped.startsWith("00") ? `+${digits.replace(/^00/, "")}` : `+${digits}`;
}

export const idParam = z.string().min(1).max(64);

export function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid input.";
  const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}

export function noContent(res: Response) {
  res.status(204).end();
}

// Thrown by services and caught by the app-level error handler, which turns it into the shared
// error shape { error: { code, message } } (Q10).
export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
