import { randomToken } from "../crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config";
import type { Repos, UserRow } from "../db/repos";
import { HermesError } from "../errors";
import { DEMO_PRIVY_DID, DEMO_USER_ID, demoWalletAddress, type AuthVerifier } from "./verifier";

declare module "fastify" {
  interface FastifyRequest {
    user: UserRow;
  }
}

export const STREAM_TICKET_TTL_MS = 120_000;

export interface Auth {
  /** Fastify preHandler: resolves `req.user` or throws 401. */
  authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** Resolve a user from a raw bearer token (or the demo user in dev mode). */
  userFromToken(token: string | undefined): Promise<UserRow>;
  mintStreamTicket(userId: string): { ticket: string; expiresAt: number };
  userFromTicket(ticket: string): UserRow | undefined;
}

export function createAuth(deps: { config: Config; repos: Repos; verifier: AuthVerifier; now?: () => number }): Auth {
  const { config, repos, verifier } = deps;
  const now = deps.now ?? Date.now;
  const tickets = new Map<string, { userId: string; expiresAt: number }>();

  function demoUser(): UserRow {
    return repos.users.upsertByPrivyDid(DEMO_PRIVY_DID, {
      id: DEMO_USER_ID,
      email: "demo@hermes.local",
      walletAddress: demoWalletAddress(),
    });
  }

  async function userFromToken(token: string | undefined): Promise<UserRow> {
    if (config.authMode === "dev") return demoUser();
    if (!token) throw new HermesError(401, "unauthorized", "Missing bearer token");
    try {
      const { privyDid } = await verifier.verify(token);
      return repos.users.upsertByPrivyDid(privyDid);
    } catch {
      throw new HermesError(401, "unauthorized", "Invalid or expired token");
    }
  }

  const bearer = (req: FastifyRequest): string | undefined => {
    const h = req.headers.authorization;
    if (!h) return undefined;
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m?.[1]?.trim();
  };

  return {
    userFromToken,
    async authenticate(req) {
      req.user = await userFromToken(bearer(req));
    },
    mintStreamTicket(userId) {
      const t = now();
      for (const [k, v] of tickets) if (v.expiresAt <= t) tickets.delete(k);
      const ticket = randomToken(24);
      const expiresAt = t + STREAM_TICKET_TTL_MS;
      tickets.set(ticket, { userId, expiresAt });
      return { ticket, expiresAt };
    },
    userFromTicket(ticket) {
      const e = tickets.get(ticket);
      if (!e || e.expiresAt <= now()) return undefined;
      return repos.users.getById(e.userId);
    },
  };
}
