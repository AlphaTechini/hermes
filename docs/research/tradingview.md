# TradingView webhook research

Researched 11 Oct 2026. tradingview.com was unreachable from the sandbox; facts come from WebSearch snippets of
TradingView's support article "How to configure webhook alerts"
(https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/), TradingView "Strategy
Alerts" / "How to use a variable value in alert" articles, and the open-source TradingView→Hyperliquid bridge
`davassi/hypertrade` (README.md, docs/tradingview-webhook.md, hypertrade/config.py, hypertrade/routes/webhooks.py).
**[tv]** = TradingView docs (via search snippet), **[ht]** = hypertrade source, **[mem]** = from memory, not re-verified, **[ours]** = proposal.

## 1. What TradingView sends

| Fact | Value | Source |
|---|---|---|
| Method | HTTP `POST` to the alert's Webhook URL | [tv] |
| Body | The alert "Message" text verbatim, after placeholder substitution | [tv] |
| Content-Type | `application/json` if the substituted message parses as valid JSON, otherwise `text/plain` (charset utf-8 [mem]) | [tv] |
| Custom headers | None can be configured. Auth must be in the URL or body | [tv], [ht] |
| Ports | Only 80 and 443; any other port is rejected | [tv] |
| IPv6 | Not supported (target must resolve to IPv4) | [tv] |
| Timeout | Request cancelled if the server takes > **3 s** to respond | [tv] |
| Retries | None documented; delivery may "occasionally fail", visible in the alert log "Webhook status" column | [tv] |
| Source IPs (for allowlist) | `52.89.214.238`, `34.212.75.30`, `54.218.53.128`, `52.32.178.7` | [tv], [ht] `config.py` default `tv_webhook_ips` |
| Requirements | 2FA enabled on the TV account; paid plan (Essential or higher per TV; free plan cannot) | [tv], details.md |

Consequences for Hermes [ours]:
- Accept both content types; always try `JSON.parse(rawBody)` (a quote inside `{{strategy.order.comment}}` turns the
  body into invalid JSON → `text/plain`). If parse fails, log as `blocked: invalid_json` with the raw body.
- Respond `200` in < 300 ms after validation + dedupe + DB insert; do the Perpl order asynchronously. Never hold the
  TV request open while waiting for `mt:24`.
- Behind Cloudflare Tunnel the peer IP is Cloudflare's; read `CF-Connecting-IP` for the optional allowlist.
  Make the allowlist optional (off for the "send test alert" button and local dev).

## 2. Placeholders

Standard (indicator and strategy alerts) **[tv]/[mem]**:
`{{ticker}}` (e.g. `BTCUSDT.P`), `{{exchange}}` (e.g. `BINANCE`), `{{interval}}` (e.g. `1`, `60`, `1D`),
`{{open}}`, `{{high}}`, `{{low}}`, `{{close}}`, `{{volume}}` (values of the bar the alert fired on; `{{close}}` is the
current price on an intrabar alert), `{{time}}` (bar open time, UTC, `yyyy-MM-ddTHH:mm:ssZ`), `{{timenow}}` (alert fire
time, UTC, same format, second precision), `{{syminfo.currency}}` (quote, e.g. `USDT`), `{{syminfo.basecurrency}}`
(base, e.g. `BTC`), `{{plot_0}}`…`{{plot_19}}` and `{{plot("Title")}}` (indicator plot values).

Strategy-only **[tv]/[ht]**:
`{{strategy.order.action}}` (`buy` | `sell`), `{{strategy.order.contracts}}` (order qty, decimal), `{{strategy.order.price}}`,
`{{strategy.order.id}}` (the id string passed to `strategy.entry/exit/close`, e.g. `Long`, `Exit Long`),
`{{strategy.order.comment}}`, `{{strategy.order.alert_message}}` (the `alert_message=` argument of the order call; empty if not set),
`{{strategy.position_size}}` (signed: >0 long, <0 short, 0 flat), `{{strategy.market_position}}` (`long` | `flat` | `short`),
`{{strategy.market_position_size}}` (absolute), `{{strategy.prev_market_position}}`, `{{strategy.prev_market_position_size}}`.

Notes:
- `alertcondition(cond, title, message)` messages support placeholders. Pine `alert(message)` messages are built in
  Pine at runtime; use `str.tostring()` there rather than relying on `{{…}}` substitution **[mem]**.
- There is **no unique per-fire id placeholder**. Idempotency must be derived (see §4).
- Placeholder values are inserted as raw text: always wrap them in quotes inside JSON and parse numbers server-side
  (an empty or `NaN` value would otherwise break JSON).

## 3. How similar tools do it

- **hypertrade** **[ht]**: JSON body sections `general{strategy,ticker,interval,time,timenow,secret,leverage,nonce}`,
  `currency{quote,base}`, `order{action,contracts,price,id,comment,alert_message}`,
  `market{position,position_size,previous_position,previous_position_size}`. Secret in body (`general.secret`, 401 if
  wrong); requires `Content-Type: application/json` (415 otherwise, which is fragile); default IP allowlist = the 4 TV
  IPs; idempotency via `general.nonce` (400 if missing, 409 in-flight duplicate, 200 `{"status":"duplicate"}` if done);
  derives a deterministic exchange client order id `0x + sha256(nonce)[:32]`. Signal derived from
  `(prev_position, position, action)`: flat→long+buy OPEN_LONG; long→flat+sell CLOSE_LONG; flat→short+sell OPEN_SHORT;
  short→flat+buy CLOSE_SHORT; long→long buy ADD_LONG / sell REDUCE_LONG; short→short sell ADD_SHORT / buy REDUCE_SHORT;
  short→long REVERSE_TO_LONG; long→short REVERSE_TO_SHORT; else NO_ACTION (`routes/webhooks.py:parse_signal`).
- **3Commas** **[mem]**: JSON `{"message_type":"bot","bot_id":123,"email_token":"<secret>","delay_seconds":0,"pair":"USDT_BTC","action":"start_deal"}` — secret token in body.
- **Alertatron** **[mem]**: text/plain command scripts, e.g. `MyKeys(BTCUSDT) { cancel(which=all); market(side=buy, amount=1); }` — key name in body.
- **PickMyTrade / TradersPost** **[web search snippets]**: JSON with a per-user token in body or URL; same 4-IP allowlist advice.

Common pattern: per-user secret in the body or URL path, JSON body, explicit action, symbol mapping done by the bridge.

## 4. Proposed Hermes alert contract [ours]

Endpoint: `POST https://<public-host>/hooks/tv/{hookId}` — `hookId` is a random 22-char base64url per strategy
(identifies user + strategy, not secret on its own). Body secret proves possession. Both are shown in the Hermes UI.

### 4.1 JSON schema (v1)

```ts
// zod-style; all placeholder-fed values are strings and parsed server-side
type HermesAlertV1 = {
  v: 1;
  secret: string;                 // per-strategy, >= 24 chars, constant-time compared with stored hash
  strategy: string;               // Hermes strategy slug, must match hookId's strategy (defence in depth)
  id?: string;                    // idempotency seed, e.g. "{{strategy.order.id}}|{{time}}" or "{{ticker}}|{{interval}}|{{time}}"
  intent?: 'open_long' | 'open_short' | 'close_long' | 'close_short' | 'close_all' | 'reverse_long' | 'reverse_short';
  action?: 'buy' | 'sell';        // strategy alerts: {{strategy.order.action}}
  position?: 'long' | 'flat' | 'short';        // {{strategy.market_position}}
  prev_position?: 'long' | 'flat' | 'short';   // {{strategy.prev_market_position}}
  position_size?: string;         // {{strategy.market_position_size}}
  contracts?: string;             // {{strategy.order.contracts}}
  symbol: string;                 // {{ticker}}, e.g. "BTCUSDT.P" → Perpl "BTC"
  exchange?: string;              // {{exchange}}
  interval?: string;              // {{interval}}
  price: string;                  // {{close}} — the "alert price" for the report card
  order_price?: string;           // {{strategy.order.price}}
  bar_time?: string;              // {{time}}
  fired_at: string;               // {{timenow}} ISO-8601 UTC
  size?: { type: 'usd' | 'base' | 'strategy'; value?: string };   // default from strategy limits
  leverage?: string;              // e.g. "3" (x); clamped to user max and market initial_margin/100
  comment?: string;               // {{strategy.order.comment}}
};
```

Resolution rules:
1. `intent` wins if present (indicator alerts). Else derive from `(prev_position, position, action)` with the
   hypertrade table above: OPEN_* → Perpl `t:1|2`; CLOSE_* → `t:3|4` with the full Perpl position size;
   ADD_* → open same side with `contracts`; REDUCE_* → close `contracts` (clamped); REVERSE_* → close then open
   (two orders, second only after the first fills). NO_ACTION → log `blocked: no_action`.
2. Symbol mapping: uppercase, strip exchange prefix (`BINANCE:`), strip suffixes `.P`, `PERP`, `USDT`, `USDC`, `USD`
   → match `market.symbol` in Perpl context (`BTC`, `ETH`, `SOL`, `MON`, `ZEC`, ...). Allow a per-strategy override map.
3. Size: `size.type='usd'` → `s = round(value / mark × 10^size_decimals)`; `'base'` → base units; `'strategy'` →
   `contracts` (TV units on the source chart; user must make the TV strategy size in base units). Reject `s == 0`.
4. Limits (allowed markets, max position, max leverage, daily loss stop, approval threshold) checked before sending.

### 4.2 Idempotency
- `dedupeKey = sha256(hookId + "|" + (body.id ?? "") + "|" + action/intent + "|" + symbol + "|" + bar_time)`;
  if `id` missing, also include `fired_at`. Unique index in DB; second arrival → `200 {"status":"duplicate"}`.
- Additionally drop byte-identical bodies for the same hook within 10 minutes (covers manual re-sends).
- `fired_at` older than 60 s vs server clock → `blocked: stale` (TV clock is UTC, second precision) — makes replays of
  a leaked body useless after a minute. Configurable.
- Each accepted alert maps to exactly one Perpl `rq` (stored), so internal retries reuse the same `rq` (perpl.md §5.9).

### 4.3 Responses
`200 {"status":"accepted","alert_id":"…"}` | `200 {"status":"duplicate","alert_id":"…"}` | `200 {"status":"blocked","reason":"…"}`
(return 200 for policy blocks so TV's log stays green and the reason lives in Hermes) | `401` bad secret |
`404` unknown hook | `400` unparseable | `413` body > 16 KB. Keep total handling well under 3 s.

### 4.4 Ready-to-paste TradingView messages

Strategy alert (Create alert → Condition: your strategy, "Order fills only"; Message):
```json
{
  "v": 1,
  "secret": "PASTE_SECRET",
  "strategy": "btc-ema-cross",
  "id": "{{strategy.order.id}}|{{time}}",
  "action": "{{strategy.order.action}}",
  "position": "{{strategy.market_position}}",
  "prev_position": "{{strategy.prev_market_position}}",
  "position_size": "{{strategy.market_position_size}}",
  "contracts": "{{strategy.order.contracts}}",
  "symbol": "{{ticker}}",
  "exchange": "{{exchange}}",
  "interval": "{{interval}}",
  "price": "{{close}}",
  "order_price": "{{strategy.order.price}}",
  "bar_time": "{{time}}",
  "fired_at": "{{timenow}}",
  "size": { "type": "usd", "value": "50" },
  "leverage": "3"
}
```

Indicator alert (one alert per direction; Condition: indicator / crossing; Message), long entry:
```json
{
  "v": 1,
  "secret": "PASTE_SECRET",
  "strategy": "btc-rsi",
  "id": "{{ticker}}|{{interval}}|{{time}}|open_long",
  "intent": "open_long",
  "symbol": "{{ticker}}",
  "exchange": "{{exchange}}",
  "interval": "{{interval}}",
  "price": "{{close}}",
  "bar_time": "{{time}}",
  "fired_at": "{{timenow}}",
  "size": { "type": "usd", "value": "50" },
  "leverage": "3"
}
```
Exit: same with `"intent": "close_long"` (and `…|close_long` in `id`). Use "Once per bar close" frequency to avoid
intrabar repeats; the `{{time}}`-based `id` dedupes repeats within a bar anyway.

Per-order JSON from Pine (strategy), using `alert_message` and Message = `{{strategy.order.alert_message}}`:
```pine
//@version=6
strategy("EMA cross", overlay=true)
f = ta.ema(close, 9), s = ta.ema(close, 21)
msg(intent) => '{"v":1,"secret":"PASTE_SECRET","strategy":"btc-ema-cross","intent":"' + intent + '","id":"' + intent + '|' + str.tostring(time) + '","symbol":"' + syminfo.ticker + '","price":"' + str.tostring(close) + '","bar_time":"' + str.tostring(time) + '","fired_at":"' + str.format_time(timenow, "yyyy-MM-dd'T'HH:mm:ss'Z'", "UTC") + '"}'
if ta.crossover(f, s)
    strategy.entry("Long", strategy.long, alert_message = msg("open_long"))
if ta.crossunder(f, s)
    strategy.close("Long", alert_message = msg("close_long"))
```
(`bar_time` here is unix ms, not ISO — accept both formats server-side.) Pine syntax not compiled by us **[?]**.

### 4.5 "Send test alert" button
Server builds the same JSON with real `{{…}}` values filled (`symbol` = chosen market, `price` = current Perpl mark,
`fired_at` = now, `id` = `test|<uuid>`) and POSTs it to its own public hook URL with `Content-Type: text/plain`
(exercises the text/plain path) — identical code path to TradingView.

## 5. Report-card timing fields [ours]
- `tv_fired_at` = `fired_at` (s precision), `received_at` (server ms), `sent_at` (mt:22 written), `accepted_at` (mt:3),
  `filled_at` = `mt:24 at.t` / fill `at.t` (block ms), `fill_tx` = `at.txid`.
- Slippage bps = `(fill_price − alert_price) / alert_price × 10^4`, sign-flipped for shorts. Note alert price comes from
  the TV source exchange (e.g. Binance) while fills are on Perpl: report the Perpl mark at receive time too, to split
  "venue basis" from "execution slippage".

## Open uncertainties
1. Exact text of TV's current IP list and whether it changed in 2026 (search results and hypertrade agree on the 4 IPs).
2. Whether TV retries failed webhooks (not documented; assume no retries, but dedupe anyway).
3. Maximum alert message length (believed ~4,000 chars [mem]); our templates are < 1 KB.
4. Whether `{{strategy.market_position_size}}` / `prev_*` placeholders exist with exactly those names in 2026 (hypertrade uses them; TV snippet listed `strategy.position_size`). Template degrades gracefully: server falls back to `action` + current Perpl position.
5. `{{timenow}}` format assumed `yyyy-MM-ddTHH:mm:ssZ`; parse leniently (also accept unix ms).
6. Whether placeholders are substituted inside Pine `alert()` messages (assumed no).
7. TradingView plan naming/requirements for webhooks (Essential+ vs Plus+) — irrelevant to code, relevant to demo.
