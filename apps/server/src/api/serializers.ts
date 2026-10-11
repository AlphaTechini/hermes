import { tradingViewTemplates, type StrategyDTO, type StrategySecretDTO, type UserDTO } from "@hermes/shared";
import type { Config } from "../config";
import { decrypt } from "../crypto";
import type { Repos, StrategyRow, UserRow } from "../db/repos";

export const webhookUrl = (config: Config, strategyId: string) => `${config.publicBaseUrl}/hooks/${strategyId}`;

export function toStrategyDTO(config: Config, repos: Repos, s: StrategyRow): StrategyDTO {
  const stats = repos.strategies.stats(s.id);
  return {
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    defaultMarket: s.defaultMarket,
    defaultSizeUsd: s.defaultSizeUsd,
    defaultLeverage: s.defaultLeverage,
    createdAt: s.createdAt,
    webhookUrl: webhookUrl(config, s.id),
    templates: tradingViewTemplates(),
    alertCount: stats.alertCount,
    lastAlertAt: stats.lastAlertAt,
  };
}

export function toStrategySecretDTO(config: Config, repos: Repos, s: StrategyRow): StrategySecretDTO {
  const secret = decrypt(s.secretEnc, config.masterKey);
  return { ...toStrategyDTO(config, repos, s), secret, templatesWithSecret: tradingViewTemplates(secret) };
}

export function toUserDTO(config: Config, u: UserRow): UserDTO {
  return {
    id: u.id,
    privyDid: u.privyDid,
    email: u.email,
    walletAddress: u.walletAddress,
    createdAt: u.createdAt,
    authMode: config.authMode,
    perplMode: config.perplMode,
  };
}
