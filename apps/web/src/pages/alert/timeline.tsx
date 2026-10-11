import type { ReactNode } from "react";
import type { AlertDetail, AlertEventDTO, Fill } from "@hermes/shared";
import { alertPipeline, STAGE_NAMES } from "../../lib/alert-view";
import type { TimelineItem } from "../../components/ui";
import { formatBlock, formatClock, formatCountdown, formatDeltaMs, formatMs, formatPrice, formatSize, formatUsd, shortId } from "../../lib/format";
import { riskChecks, type ChecksResult } from "./derive";
import { placedInfo } from "./frame";

const M = ({ children }: { children: ReactNode }) => <span className="mono">{children}</span>;
const nf = new Intl.NumberFormat("en-US");

export interface BuiltTimeline {
  items: TimelineItem[];
  totalMs: number | null;
  axisMid: string[];
  axisTotal: string | undefined;
}

function niceStep(raw: number): number {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
  return steps.find((s) => s >= raw) ?? steps[steps.length - 1]!;
}

const axisLabel = (ms: number) => (ms >= 1000 ? `${+(ms / 1000).toFixed(2)} s` : `${ms}`);

export function buildTimeline(d: AlertDetail, checksIn?: ChecksResult): BuiltTimeline {
  const checks = checksIn ?? riskChecks(d);
  const strategyPath = `/hooks/${d.strategyId}`;
  const fillById = new Map<string, Fill>(d.fills.map((f) => [f.id, f]));
  const approval = d.approval;

  type Row = Omit<TimelineItem, "time" | "delta" | "bar" | "deltaTone"> & { at: number | null };
  const rows: Row[] = [];
  let stop: "blocked" | "failed" | null = null;

  for (const e of d.events as AlertEventDTO[]) {
    const det = (e.detail ?? {}) as Record<string, unknown>;
    switch (e.status) {
      case "received":
        rows.push({
          at: e.atMs,
          title: "Received",
          state: "done",
          description: det.source === "test-alert" ? <>Test alert posted by Hermes to <M>{strategyPath}</M></> : <>POST from TradingView to <M>{strategyPath}</M></>,
        });
        break;
      case "verified":
        rows.push({ at: e.atMs, title: "Verified", state: "done", description: "Secret matches. Alert id is new. Message has every required field." });
        break;
      case "risk_checked": {
        const needs = det.needsApproval === true;
        const isClose = d.kind === "close";
        const counts = `${checks.passed} of ${checks.evaluated} checks passed.`;
        const waited = approval?.decidedAt ? formatCountdown(Math.round((approval.decidedAt - approval.createdAt) / 1000)) : null;
        rows.push({
          at: e.atMs,
          title: "Risk checks passed",
          state: "done",
          description: isClose
            ? `Closing order. ${counts} Limits on new exposure are skipped.`
            : needs
              ? `${counts} Above the approval threshold${waited ? `. Waited ${waited} for you.` : ", so it waits for you."}`
              : `${counts} Under the approval threshold, sent without waiting.`,
        });
        break;
      }
      case "pending_approval":
        rows.push({
          at: e.atMs,
          title: "Waiting for your approval",
          state: "done",
          description: <>Expires at <M>{formatClock(num(det.expiresAt) ?? approval?.expiresAt ?? null, { ms: false })}</M></>,
        });
        break;
      case "sent":
        rows.push({
          at: e.atMs,
          title: "Sent to Perpl",
          state: "done",
          description: (
            <>
              Order frame <M>mt 22</M>
              {num(det.rq) !== null && <> · <M>rq {nf.format(num(det.rq)!)}</M></>}
              {num(det.sn) !== null && <> · <M>sn {nf.format(num(det.sn)!)}</M></>}
              {num(det.lb) !== null && num(det.lb)! > 0 && <> · last block <M>{formatBlock(num(det.lb))}</M></>}
            </>
          ),
        });
        break;
      case "accepted": {
        const placed = placedInfo(d);
        const oid = placed?.oid ?? (typeof det.perplOrderId === "string" && Number.isFinite(Number(det.perplOrderId)) ? Number(det.perplOrderId) : null);
        rows.push({
          at: e.atMs,
          title: "Accepted",
          state: "done",
          description: (
            <>
              {placed?.forwarded ? <>Forwarded (<M>mt 3</M>), then placed</> : <>Placed</>}
              {placed?.block != null && <> in block <M>{formatBlock(placed.block)}</M></>} (<M>mt 24</M>
              {oid !== null && <>, order <M>{nf.format(oid)}</M></>})
            </>
          ),
        });
        break;
      }
      case "dry_run":
        rows.push({ at: e.atMs, title: "Dry run, stopped here", state: "done", description: typeof det.message === "string" ? det.message : "This strategy is in dry run. Every check ran and nothing was sent to Perpl." });
        break;
      case "filled":
      case "partially_filled": {
        const f = typeof det.fillId === "string" ? fillById.get(det.fillId) : undefined;
        const price = f?.price ?? num(det.price);
        const size = f?.size ?? num(det.size);
        rows.push({
          at: e.atMs,
          title: e.status === "filled" ? "Filled" : "Partly filled",
          state: e.status === "filled" ? "final" : "done",
          description: (
            <>
              <M>
                {formatSize(size, d.market)} @ {formatPrice(price, d.market)}
              </M>
              {f?.block != null && (
                <>
                  {" "}in block <M>{formatBlock(f.block)}</M>
                </>
              )}{" "}
              (<M>mt 25</M>){f ? <> · fee <M>{formatUsd(f.fee)}</M></> : null}
            </>
          ),
        });
        break;
      }
      case "blocked":
        stop = "blocked";
        if (d.blockReason === "approval_rejected") {
          rows.push({ at: e.atMs, title: <span className="warn">Rejected by you</span>, state: "blocked", description: "You rejected the approval. Nothing was sent to Perpl." });
        } else {
          rows.push({
            at: e.atMs,
            title: <span className="warn">Blocked by risk checks</span>,
            state: "blocked",
            description: `${checks.failedName ?? "A check"} failed.${checks.passed > 0 ? ` ${checks.passed} other ${checks.passed === 1 ? "check" : "checks"} passed.` : ""}`,
          });
        }
        break;
      case "expired": {
        stop = "blocked";
        const waited = approval ? Math.round((approval.expiresAt - approval.createdAt) / 1000) : null;
        rows.push({ at: e.atMs, title: <span className="warn">Approval expired</span>, state: "blocked", description: `Not approved${waited ? ` in ${formatCountdown(waited)}` : " in time"}. Nothing was sent to Perpl.` });
        break;
      }
      case "failed": {
        stop = "failed";
        const msg = typeof det.message === "string" ? det.message : null;
        rows.push({ at: e.atMs, title: <span className="neg">Order failed</span>, state: "failed", description: msg ?? humanize(d.errorCode) });
        break;
      }
      case "duplicate":
        stop = "blocked";
        rows.push({ at: e.atMs, title: <span className="warn">Ignored as a duplicate</span>, state: "blocked", description: <>Same alert id as <M>{typeof det.duplicateOf === "string" ? shortId(det.duplicateOf) : "an earlier alert"}</M>. Hermes acts on each id once.</> });
        break;
      case "invalid": {
        stop = "failed";
        const issues = Array.isArray(det.issues) ? (det.issues as { path?: string; message?: string }[]).map((i) => `${i.path ? `${i.path}: ` : ""}${i.message ?? ""}`).join(" · ") : "";
        rows.push({ at: e.atMs, title: <span className="neg">Message was not valid</span>, state: "failed", description: issues || "A required field is missing." });
        break;
      }
      case "rejected_auth":
        stop = "failed";
        rows.push({ at: e.atMs, title: <span className="neg">Secret did not match</span>, state: "failed", description: authWhy(det.why) });
        break;
    }
  }

  // An approval decision is not an alert event: show it between the request and what followed.
  if (approval && approval.status === "approved" && approval.decidedAt) {
    const idx = rows.findIndex((r) => r.title === "Waiting for your approval");
    if (idx >= 0) rows.splice(idx + 1, 0, { at: approval.decidedAt, title: "Approved", state: "done", description: `You approved the order after ${formatCountdown(Math.round((approval.decidedAt - approval.createdAt) / 1000))}.` });
  }
  rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  // Stages that never happened.
  const pipe = alertPipeline(d);
  if (d.status === "dry_run") {
    rows.push({ at: null, title: "Sent, accepted, filled", state: "skipped", description: "Skipped. Dry run, nothing was sent to Perpl." });
  }
  if (stop && pipe.stoppedAt >= 0 && pipe.stoppedAt < 5) {
    const names = STAGE_NAMES.slice(pipe.stoppedAt + 1);
    if (names.length) {
      rows.push({
        at: null,
        title: names.map((n, i) => (i === 0 ? n : n.toLowerCase())).join(", "),
        state: "skipped",
        description: d.status === "blocked" || d.status === "expired" ? "Skipped. Hermes does not send orders that fail a check." : "Skipped. Nothing else happens to this alert.",
      });
    }
  }

  const timed = rows.filter((r) => r.at !== null);
  const t0 = timed[0]?.at ?? null;
  const tEnd = timed.length ? timed[timed.length - 1]!.at! : null;
  const total = t0 !== null && tEnd !== null ? Math.max(0, tEnd - t0) : null;

  const items: TimelineItem[] = rows.map((r, i) => {
    const { at, ...rest } = r;
    if (at === null || t0 === null) return { ...rest, time: "n/a", delta: "n/a" };
    const prev = i > 0 ? (rows[i - 1]!.at ?? t0) : at;
    const delta = i === 0 ? 0 : Math.max(0, at - prev);
    const tone = r.state === "final" ? "positive" : r.state === "blocked" ? "warning" : r.state === "failed" ? "negative" : undefined;
    const barTone = r.state === "blocked" ? "warning" : r.state === "failed" ? "negative" : undefined;
    const T = total && total > 0 ? total : 1;
    return {
      ...rest,
      key: `${i}`,
      time: formatClock(at),
      delta: formatDeltaMs(delta, { first: i === 0 }),
      ...(tone ? { deltaTone: tone } : {}),
      bar: { left: i === 0 ? 0 : ((prev - t0) / T) * 100, width: i === 0 ? 0 : (delta / T) * 100, ...(barTone ? { tone: barTone } : {}) },
    };
  });

  let axisMid: string[] = [];
  if (total && total >= 20) {
    const step = niceStep(total / 3);
    for (let v = step; v < total - step * 0.5; v += step) axisMid.push(axisLabel(v));
    axisMid = axisMid.slice(0, 3);
  }
  return { items, totalMs: total, axisMid, axisTotal: total !== null ? formatMs(total) : undefined };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function humanize(code: string | null): string {
  if (!code) return "Perpl did not fill the order.";
  const s = code.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function authWhy(why: unknown): string {
  switch (why) {
    case "strategy_disabled":
      return "The strategy is off, so Hermes ignored the alert.";
    case "missing_secret":
      return "The message has no secret. Add it to your TradingView message.";
    case "unparseable_body":
      return "The body was not valid JSON. Check the TradingView message.";
    default:
      return "The secret in the message is not the strategy's secret. Hermes ignored the alert.";
  }
}
