import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "@continuum/config";

export const SESSION_COOKIE = "continuum_session";

function equalSecret(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenFromRequest(request: FastifyRequest): string | undefined {
  const cookieToken = request.cookies?.[SESSION_COOKIE];
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  return cookieToken ?? bearer;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export async function installSecurityHooks(app: FastifyInstance, config: AppConfig): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!isLoopbackHostname(request.hostname)) {
      await reply.code(403).send({ error: { code: "LOOPBACK_ONLY", message: "Continuum only accepts local connections.", retryable: false, traceId: request.id } });
      return;
    }
    if (!request.url.startsWith("/api/v1")) return;
    if (!equalSecret(tokenFromRequest(request), config.sessionToken)) {
      await reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "This browser session is no longer connected to Continuum.", retryable: true, traceId: request.id } });
      return;
    }
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.has(origin)) {
      await reply.code(403).send({ error: { code: "ORIGIN_REJECTED", message: "The request came from an untrusted origin.", retryable: false, traceId: request.id } });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers["x-continuum-request"] !== "1") {
      await reply.code(403).send({ error: { code: "CSRF_REJECTED", message: "The request was missing local-session protection.", retryable: false, traceId: request.id } });
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    return payload;
  });
}
