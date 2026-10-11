import type { AccountSummary } from "@hermes/shared";
import type { Repos } from "../db/repos";
import { utcDay } from "../db/repos";

const cents = (x: number): number => Math.round(x * 100) / 100;

/**
 * Add today's PnL and the daily loss stop usage to an account summary.
 *
 * Today PnL = realised PnL booked today (UTC, from the database) + the current unrealised PnL of the open positions
 * (from the Perpl position snapshot). This is the number the top bar shows as "Today" and the number the daily loss stop
 * is evaluated against (see risk/evaluate.ts), so the meter and the gate can never disagree.
 */
export function withTodayPnl(repos: Repos, userId: string, account: AccountSummary, nowMs: number = Date.now()): AccountSummary {
  const realized = repos.dailyPnl.get(userId, utcDay(nowMs));
  const unrealized = account.unrealizedPnlUsd;
  const today = realized + unrealized;
  const stop = repos.limits.get(userId).dailyLossStopUsd;
  return {
    ...account,
    realizedPnlTodayUsd: realized,
    todayPnlUsd: cents(today),
    todayRealizedUsd: cents(realized),
    todayUnrealizedUsd: cents(unrealized),
    lossStopUsd: stop,
    lossStopUsedUsd: cents(Math.max(0, -today)),
  };
}
