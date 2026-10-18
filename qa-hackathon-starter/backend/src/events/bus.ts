// Live updates (Q11, D09): an in-process, workspace-scoped publish/subscribe feeding the SSE
// endpoint. Events are only a "something changed" nudge; the database stays the source of truth,
// so a missed event costs a refetch, never a wrong record.
import { EventEmitter } from "node:events";
import { Router } from "express";
import type { Db } from "../db.ts";
import { requireAuth } from "../middleware/requireAuth.ts";

export interface LiveEvent {
  type: "newLead" | "escalation" | "incomingMessage" | "leadUpdated" | "paymentUpdated";
  title: string;
  detail: string;
  tone?: "success" | "warning" | "info" | "error";
  leadId?: string;
  userId?: string; // when set, only this user's stream receives it
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(workspaceId: string, event: LiveEvent) {
  bus.emit(workspaceId, event);
}

export function eventsRouter(db: Db) {
  const router = Router();
  router.get("/", requireAuth(db), (req, res) => {
    const { workspaceId, userId } = req.session!;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const listener = (event: LiveEvent) => {
      if (event.userId && event.userId !== userId) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    bus.on(workspaceId, listener);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000); // keeps proxies from closing the stream
    req.on("close", () => {
      clearInterval(heartbeat);
      bus.off(workspaceId, listener);
    });
  });
  return router;
}
