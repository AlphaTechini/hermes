import { PolicyDemoRequest, SignerRegisteredRequest, WalletActionRequest } from "@hermes/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse } from "../api/helpers";
import type { Auth } from "../auth/plugin";
import type { WalletModule } from "./module";

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/**
 * Privy wallet endpoints (all authenticated):
 *   GET  /api/privy/signer-config      -> { keyQuorumId, policyIds, ... } for useSigners().addSigners
 *   GET  /api/privy/wallet             -> the stored wallet / signer status (or null)
 *   POST /api/privy/signer-registered  -> confirm with Privy that the signer was added, then persist
 *   POST /api/wallet/actions           -> server-signed tx under the policy
 *   GET  /api/wallet/actions           -> history
 *   POST /api/wallet/policy-demo       -> a forbidden tx that the policy must deny
 */
export function walletRoutes(app: FastifyInstance, deps: { auth: Auth; wallet: WalletModule }): void {
  const { auth, wallet } = deps;
  app.register(async (api) => {
    api.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => auth.authenticate(req, reply));

    api.get("/api/privy/signer-config", async () => wallet.signerConfig());
    api.get("/api/privy/wallet", async (req) => wallet.getWallet(req.user.id));
    api.post("/api/privy/signer-registered", async (req) => {
      const body = parse(SignerRegisteredRequest, req.body);
      return wallet.registerSigner(req.user, body.address);
    });

    api.post("/api/wallet/actions", async (req) => wallet.runAction(req.user, parse(WalletActionRequest, req.body)));
    api.get("/api/wallet/actions", async (req) => wallet.list(req.user.id, parse(ListQuery, req.query).limit));
    api.post("/api/wallet/policy-demo", async (req) => wallet.policyDemo(req.user, parse(PolicyDemoRequest, req.body ?? {})));
  });
}
