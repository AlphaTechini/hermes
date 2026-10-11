import type { TradingViewTemplates } from "./dto";

export const SECRET_PLACEHOLDER = "YOUR_SECRET";

/**
 * TradingView alert-message templates. These are real TradingView placeholder strings: TradingView
 * substitutes `{{...}}` when the alert fires and POSTs the result. Numbers are quoted so a missing
 * value still yields valid JSON; Hermes coerces them.
 */
export function tradingViewTemplates(
  secret: string = SECRET_PLACEHOLDER,
  opts: { action?: string; sizeUsd?: number } = {},
): TradingViewTemplates {
  const action = opts.action ?? "buy";
  const isClose = action === "flat" || action.startsWith("close");
  return {
    indicator: [
      "{",
      `  "secret": "${secret}",`,
      `  "action": "${action}",`,
      `  "market": "{{ticker}}",`,
      ...(isClose ? [] : [`  "size_usd": "${opts.sizeUsd ?? 100}",`]),
      `  "price": "{{close}}",`,
      `  "time": "{{timenow}}"`,
      "}",
    ].join("\n"),
    strategy: [
      "{",
      `  "secret": "${secret}",`,
      `  "id": "{{strategy.order.id}}-{{timenow}}",`,
      `  "action": "{{strategy.order.action}}",`,
      `  "market": "{{ticker}}",`,
      `  "size": "{{strategy.order.contracts}}",`,
      `  "market_position": "{{strategy.market_position}}",`,
      `  "price": "{{close}}",`,
      `  "time": "{{timenow}}"`,
      "}",
    ].join("\n"),
  };
}

/** Substitute `{{placeholder}}` tokens exactly as TradingView would. Unknown placeholders are left intact. */
export function renderTradingViewMessage(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, key: string) => values[key] ?? whole);
}
