import { ArrowUpRight, Bell, CircleCheck, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { CodeBlock } from "../../components/ui/CodeBlock";
import { LifecyclePipeline, type PipelineStageInput } from "../../components/ui/LifecyclePipeline";
import type { StageState } from "../../lib/alert-view";

const MS = ["0 ms", "+4 ms", "+2 ms", "+11 ms", "+184 ms", "+411 ms"];
const PAYLOAD = '{ "market": "BTC", "action": "buy", "size": "0.050", "price": "112031.0" }';

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Replays one alert through the six stages: the active stage shows the accent sheen and `…`, each completed stage fills
 * in 180 ms, and Filled turns positive. 380 ms per early stage, 700 ms for Accepted and Filled, a 2.6 s pause on the
 * result (DESIGN.md 10.1). With reduced motion it rests on the finished state.
 */
function useRelayReplay(): number {
  const [step, setStep] = useState(() => (prefersReducedMotion() ? 6 : 0));
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const next = step === 6 ? 0 : step + 1;
    const delay = next === 0 ? 2600 : next >= 5 ? 700 : 380;
    const t = setTimeout(() => setStep(next), delay);
    return () => clearTimeout(t);
  }, [step]);
  return step;
}

export function RelayCard() {
  const step = useRelayReplay();
  const stages: PipelineStageInput[] = MS.map((ms, k) => {
    const state: StageState = k < step ? (k === 5 ? "final" : "done") : k === step ? "active" : "pending";
    return { state, label: k < step ? ms : k === step ? "…" : "" };
  });
  const done = step === 6;

  return (
    <div className="relay-stack">
      <div className="relay" aria-label="An alert from TradingView becoming a Perpl fill">
        <div className="relay-head">
          <span className="hm-dot" data-tone="positive" data-live="true" />
          <span>
            Alert <span className="mono secondary">A-10482</span>
          </span>
          <span className="faint">·</span>
          <span>Breakout 15m</span>
          <span style={{ marginLeft: "auto" }} className="mono">
            14:32:07.412
          </span>
        </div>
        <div className="relay-sec">
          <div className="relay-lbl">
            <Bell className="i-12" aria-hidden />
            TradingView sends<span className="k">POST /v1/alerts/stg_8Kq2Zr</span>
          </div>
          <CodeBlock code={PAYLOAD} noCopy />
        </div>
        <div className="relay-sec">
          <div className="relay-lbl">
            <Zap className="i-12" aria-hidden />
            Hermes relays
          </div>
          <LifecyclePipeline stages={stages} size="lg" showLabels />
        </div>
        <div className="relay-sec">
          <div className="relay-lbl">
            <CircleCheck className="i-12 pos" aria-hidden />
            Perpl fills
            <span className="mono row" style={{ marginLeft: "auto", gap: 4, color: "var(--accent-text)" }} title="Example transaction">
              0x8f3a…e21c
              <ArrowUpRight className="i-12" aria-hidden />
            </span>
          </div>
          <div className="relay-result" style={{ opacity: done ? 1 : 0.35 }}>
            <div>
              <div className="l">Alert price</div>
              <div className="v">112,031.0</div>
            </div>
            <div>
              <div className="l">Fill price</div>
              <div className="v">112,048.5</div>
            </div>
            <div>
              <div className="l">Slippage</div>
              <div className="v">1.6 bps</div>
            </div>
            <div>
              <div className="l">Alert to fill</div>
              <div className="v">612 ms</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
