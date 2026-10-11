/**
 * View helpers that turn a server `AlertRecord` into what the UI draws:
 *  - {@link alertPipeline}: the six-stage lifecycle (`<LifecyclePipeline stages={...} />`)
 *  - {@link alertOutcome}: the status pill kind, label and the sub-line under it
 *  - {@link alertSide}: which SideLabel to show
 *
 * Pipeline state comes from the server events, never from client timers (DESIGN.md section 13.4).
 * Stage deltas are differences of server `atMs` timestamps.
 */
import { BLOCK_REASON_LABELS, type AlertRecord, type AlertStatus, type BlockReason } from "@hermes/shared";
import { formatBps, formatDeltaMs, formatMs, formatPrice, shortId } from "./format";

export const STAGE_NAMES = ["Received", "Verified", "Checked", "Sent", "Accepted", "Filled"] as const;
export type StageName = (typeof STAGE_NAMES)[number];
export type StageState = "pending" | "active" | "done" | "final" | "blocked" | "failed" | "skipped";

export interface PipelineStage {
  name: StageName;
  state: StageState;
  /** Delta in ms since the previous reached stage. `null` when not reached. */
  ms: number | null;
  /** Server timestamp (epoch ms, 3 decimals) when the stage was reached. `null` when not reached. */
  atMs: number | null;
  /** What the ms slot shows: `0 ms`, `+184 ms`, `…` while active, `waiting` for approval, or empty. */
  label: string;
}

export interface AlertPipeline {
  stages: PipelineStage[];
  /** Received to the terminal stage, ms. `null` while in flight. */
  totalMs: number | null;
  /** True when the alert is waiting for the user's approval (stage 4 shows "waiting"). */
  awaitingApproval: boolean;
  /** Index of the stage where it stopped, or -1. */
  stoppedAt: number;
}

const STAGE_OF: Partial<Record<AlertStatus, number>> = {
  received: 0,
  verified: 1,
  risk_checked: 2,
  sent: 3,
  accepted: 4,
  partially_filled: 5,
  filled: 5,
};

const FILLED: AlertStatus[] = ["filled", "partially_filled"];

export function alertPipeline(alert: Pick<AlertRecord, "status" | "events">): AlertPipeline {
  const at: (number | null)[] = [null, null, null, null, null, null];
  let terminalAt: number | null = null;
  let sawApproval = false;
  for (const e of alert.events) {
    const idx = STAGE_OF[e.status];
    if (idx !== undefined) {
      // The first occurrence of a stage wins, except Filled which tracks the first fill.
      if (at[idx] === null) at[idx] = e.atMs;
    } else if (e.status === "pending_approval") sawApproval = true;
    else terminalAt = e.atMs;
  }
  const status = alert.status;
  const reached = at.reduce<number>((acc, v, i) => (v !== null ? i : acc), -1);
  const states: StageState[] = Array(6).fill("pending");
  let stoppedAt = -1;

  for (let i = 0; i <= reached; i++) states[i] = "done";

  const stopAt = (i: number, st: StageState) => {
    stoppedAt = Math.min(i, 5);
    for (let k = 0; k < 6; k++) states[k] = k < stoppedAt ? "done" : k === stoppedAt ? st : "skipped";
  };

  const inFlight = !["filled", "partially_filled", "blocked", "duplicate", "rejected_auth", "invalid", "expired", "failed", "dry_run"].includes(status);
  const awaitingApproval = status === "pending_approval";

  if (FILLED.includes(status)) {
    states.fill("done");
    states[5] = "final";
  } else if (status === "duplicate") stopAt(1, "blocked");
  else if (status === "rejected_auth" || status === "invalid") stopAt(1, "failed");
  else if (status === "blocked") {
    // Hermes limits stop at Checked; a rejected approval stops where the order would have been Sent.
    stopAt(sawApproval ? 3 : 2, "blocked");
  } else if (status === "expired") stopAt(3, "blocked");
  else if (status === "failed") stopAt(reached + 1, "failed");
  else if (inFlight) {
    const next = awaitingApproval ? -1 : Math.min(reached + 1, 5);
    if (next >= 0) states[next] = "active";
    if (awaitingApproval) for (let i = 0; i <= 2; i++) states[i] = "done";
  }

  // Deltas: since the previous stage that has a timestamp. A blocked/failed stage uses the terminal event time.
  const times = at.slice();
  if (stoppedAt >= 0 && terminalAt !== null) times[stoppedAt] = terminalAt;
  const stages: PipelineStage[] = STAGE_NAMES.map((name, i) => {
    const state = states[i] ?? "pending";
    const t = times[i] ?? null;
    let prev: number | null = null;
    for (let k = i - 1; k >= 0; k--) {
      const v = times[k];
      if (v !== null && v !== undefined) {
        prev = v;
        break;
      }
    }
    const ms = t !== null ? (i === 0 || prev === null ? 0 : Math.max(0, t - prev)) : null;
    let label = "";
    if (state === "active") label = "…";
    else if (awaitingApproval && i === 3) label = "waiting";
    else if (ms !== null && state !== "pending" && state !== "skipped") label = formatDeltaMs(ms, { first: i === 0 });
    return { name, state, ms, atMs: t, label };
  });

  const start = at[0] ?? null;
  let end: number | null = null;
  if (FILLED.includes(status)) end = at[5] ?? null;
  else if (stoppedAt >= 0 || status === "dry_run") end = terminalAt;
  const totalMs = start !== null && end !== null ? Math.max(0, end - start) : null;

  return { stages, totalMs, awaitingApproval, stoppedAt };
}

// --- outcome -------------------------------------------------------------------------

export type OutcomeKind =
  | "in_flight"
  | "needs_approval"
  | "filled"
  | "partly_filled"
  | "blocked"
  | "dry_run"
  | "not_filled"
  | "rejected"
  | "ignored"
  | "expired"
  | "bad_secret"
  | "invalid";

export interface AlertOutcome {
  kind: OutcomeKind;
  label: string;
  /** Sub-line under the pill, e.g. `112,048.5 · 1.6 bps` or `Over max position size`. `mono` marks values to set in Geist Mono. */
  why: string;
  mono: boolean;
}

export const OUTCOME_LABELS: Record<OutcomeKind, string> = {
  in_flight: "In flight",
  needs_approval: "Needs approval",
  filled: "Filled",
  partly_filled: "Partly filled",
  blocked: "Blocked",
  dry_run: "Dry run",
  not_filled: "Not filled",
  rejected: "Rejected by Perpl",
  ignored: "Ignored",
  expired: "Expired",
  bad_secret: "Bad secret",
  invalid: "Invalid message",
};

/** Short, plain reasons for the stream sub-line (DESIGN.md section 10.3). */
export function blockReasonShort(reason: BlockReason | null, market?: string | null): string {
  switch (reason) {
    case "market_not_allowed":
      return `${market ?? "This market"} is not an allowed market`;
    case "size_above_max":
      return "Over max position size";
    case "leverage_above_max":
      return "Over your max leverage";
    case "daily_loss_stop_hit":
      return "Daily loss stop reached";
    case "approval_rejected":
      return "You rejected the approval";
    case "approval_expired":
      return "Not approved in time";
    case null:
      return "Blocked by a limit";
    default:
      return BLOCK_REASON_LABELS[reason];
  }
}

export function alertOutcome(alert: AlertRecord): AlertOutcome {
  const dupOf = (alert.events.find((e) => e.status === "duplicate")?.detail?.duplicateOf as string | undefined) ?? null;
  const o = (kind: OutcomeKind, why = "", mono = false): AlertOutcome => ({ kind, label: OUTCOME_LABELS[kind], why, mono });
  switch (alert.status) {
    case "filled":
    case "partially_filled": {
      const why =
        alert.avgFillPrice !== null
          ? `${formatPrice(alert.avgFillPrice, alert.market)}${alert.slippageBps !== null ? ` · ${formatBps(alert.slippageBps)}` : ""}`
          : "";
      return o(alert.status === "filled" ? "filled" : "partly_filled", why, true);
    }
    case "pending_approval":
      return o("needs_approval", "Waiting for you");
    case "blocked":
      return o("blocked", blockReasonShort(alert.blockReason, alert.market));
    case "failed":
      return alert.errorCode === "order_rejected"
        ? o("rejected", "Perpl refused the order")
        : o("not_filled", alert.errorCode === "timeout" ? "No fill in time" : humanizeCode(alert.errorCode));
    case "duplicate":
      return o("ignored", dupOf ? `Duplicate of ${shortId(dupOf)}` : "Duplicate alert", dupOf !== null);
    case "dry_run":
      return o("dry_run", "Checks passed, not sent");
    case "expired":
      return o("expired", "Not approved in time");
    case "rejected_auth":
      return o("bad_secret", "Secret did not match");
    case "invalid": {
      const issues = alert.events.find((e) => e.status === "invalid")?.detail?.issues;
      const path = Array.isArray(issues) ? (issues[0] as { path?: unknown } | undefined)?.path : undefined;
      return o("invalid", typeof path === "string" && path ? `${path} is missing or invalid` : "A required field is missing");
    }
    default:
      return o("in_flight", "Waiting for Perpl fill");
  }
}

function humanizeCode(code: string | null): string {
  if (!code) return "Perpl did not fill the order";
  const s = code.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- side ----------------------------------------------------------------------------

export type SideKind = "long" | "short" | "close-long" | "close-short" | "close";

/** Which SideLabel an alert maps to. A generic close (no side) is `close`. */
export function alertSide(alert: Pick<AlertRecord, "side" | "kind">): SideKind {
  if (alert.kind === "close") return alert.side === "long" ? "close-long" : alert.side === "short" ? "close-short" : "close";
  return alert.side === "short" ? "short" : alert.side === "long" ? "long" : "close";
}

/** `Total` column text: `612 ms`, or `n/a` while in flight. */
export const formatTotal = (totalMs: number | null): string => (totalMs === null ? "n/a" : formatMs(totalMs));
