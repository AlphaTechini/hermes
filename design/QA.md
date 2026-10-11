# Hermes design QA, built app vs prototype

Reviewer: design. Build reviewed: working tree on top of `d465dfa` (web unchanged from HEAD; server bundled from the working tree), DEV auth, simulated Perpl, seeded demo data plus `demo:alerts` running. Every route was captured at 1440x900 (full page) and 390x844, dark and light, and compared side by side with `design/screenshots/`. I also tested hover, keyboard focus, drawers and modals, loading, error, empty and offline states (by intercepting API calls), and recorded frames of a new alert arriving on Live.

Evidence: `design/qa-shots/NN-*.png`. In the side by side images the built app is on the left and the prototype on the right.

**Verdict.** The build is very close to the prototype. Tokens, type scale, spacing, the pipeline and the table rhythm are all faithful (measured styles match the prototype on every page except where listed). No em dashes and no hyphen minus signs anywhere in the UI. No horizontal scroll at 390px. Light theme holds up. What is left falls into three groups: (1) **trust bugs**, where the UI shows evidence that is false (risk checks shown as passed when they never ran, an order frame comment that contradicts its value, KPIs of 0 when loading failed); (2) **robustness**, since one render error blanks the whole app; and (3) a set of **n/a leaks and class collisions** that make good screens look unfinished.

**Counts: P0 2 · P1 24 · P2 39.** (R1 and AP1 are the same root cause as G7, listed where they show.)

Severity: **P0** broken or misleading, fix before demo · **P1** visibly off or inconsistent · **P2** polish.

---

## Global, shell and shared components

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| G1 | **P0** | There is no error boundary. Any exception during render blanks the whole app (black canvas, no shell, no way back). Reproduced by returning `{items:[]}` from `/api/positions`: `list.reduce is not a function` takes everything down. The server DTOs are changing right now, so this will happen. | `App.tsx`, `components/shell/AppShell.tsx` (no `ErrorBoundary` anywhere in `src`) | Wrap the `<Outlet/>` in `AppShell` (and the onboarding page) in an error boundary keyed by `pathname`. Fallback: `EmptyState` with icon `circle-alert`, title "This page hit an error", body "The rest of Hermes still works. Reload the page, or go back to Live.", actions "Reload" (primary sm) and "Back to Live" (ghost sm). Keep the sidebar and top bar rendered. Also guard array hooks in `lib/queries.ts` with `Array.isArray(x) ? x : x?.items ?? []`. |
| G2 | P1 | `.pill.outline` collides with Tailwind's `outline` utility (`outline-style: solid; outline-width: 1px` in currentColor). Outline pills get a second ring in the text color: the "Connected" pill on Wallet, the Connected, Reconnecting and Offline pills on /components, and the Missed, Blocked and Ignored kind pills on Report. Shots 28, 31. | `components/ui/Badges.tsx:95,114`, `styles/app.css:327` | Rename the modifier to `.pill-outline` (`.pill.pill-outline { background: transparent; border-color: var(--border); }`) and update both usages. Verify that computed `outline-style` is `none`. |
| G3 | P1 | `.list-item` collides with Tailwind's `list-item` (`display: list-item`). This is the known issue, still present. `StrategyList` hides it with inline `style={{display:"flex", listStyle:"none"}}`, but the shared `ListItem` (`Misc.tsx:110`) still renders with bullets for anyone who uses it. | `styles/app.css:562-565`, `components/ui/Misc.tsx:110`, `pages/strategies/StrategyList.tsx:49,70` | Rename to `.li-row` in app.css and Misc.tsx, then delete the inline display and listStyle overrides in StrategyList. Audit result: the other collisions are `grid`, `grow` and `truncate`, and they are harmless (same meaning, or an SVG `<g>`). |
| G4 | P1 | A selected segmented item loses its focus ring. `.seg [aria-pressed="true"]` sets `box-shadow: 0 0 0 1px var(--border)`, which overrides the base `:focus-visible` ring, so tabbing onto "All 200" shows nothing. Shot 08. Applies everywhere `SegmentedControl` is used: Live filter, Report range, Strategy size mode, Policy check. | `styles/app.css:288` | Add `.seg [aria-pressed="true"]:focus-visible, .seg [aria-selected="true"]:focus-visible { box-shadow: var(--focus-ring); }`. Check `.list-item[aria-current]` the same way (it uses an inset box shadow). |
| G5 | P1 | On `/alerts/:id` the sidebar highlights nothing. The prototype keeps **Live** current (the breadcrumb is "Live › A-10482"). | `components/shell/Sidebar.tsx:12` (`NavLink`) | For the Live entry use `className={({isActive}) => cn("nav-item", (isActive \|\| pathname.startsWith("/alerts/")) && "active")}`, or the same with `aria-current`. |
| G6 | P1 | The mobile nav drawer (< 768) does not move focus into the drawer when it opens, and focus is not trapped (`document.activeElement` stays on `body`). DESIGN 9 Drawer: "focus is trapped". Shot 37. | `AppShell.tsx` / `Sidebar.tsx` (body `nav-open`) | On open, focus the current nav item. Trap Tab inside `.sidebar` and return focus to the "Open navigation" button on close. Add a 32px ghost close icon button (`x`, `aria-label="Close navigation"`) at the right of `.sb-head` on mobile. |
| G7 | P1 | Mark prices fall back to `n/a` wherever there is no open position. Approvals "Mark now: n/a, No open position to read it from" (shot 26), Limits market tiles "SOL n/a, MON n/a, ZEC n/a" (shots 22, 25). The mark is a market value and must not depend on holding a position. | `pages/approvals/ApprovalsPage.tsx:223-226`, `pages/limits/LimitsPage.tsx:133` | Read marks from market data (Perpl `pub/context` / ticker via a `useMarkets()` query; ask the backend for `/api/markets` with `markPrice` if it is missing). Show `n/a` only when the ticker itself is unavailable, and use the sub-line "No mark price from Perpl". |
| G8 | P2 | The sidebar border and background stop at 100dvh in full-page captures and print. The sidebar is `position: sticky; height: 100dvh`. Live scrolling is correct, so this is the known issue, cosmetic only. | `styles/app.css:70-74` | Let the grid cell stretch and make the inner part sticky: `.sidebar { align-self: stretch; height: auto; }` plus a wrapper `.sb-inner { position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; }` around head, nav and footer. The border then runs the full page height, as in the prototype. |
| G9 | P2 | The icon rail (768 to 1279) uses the native `title` attribute, not the Hermes Tooltip. It shows after about 1s, unstyled. Shot 07. | `Sidebar.tsx:12` | In rail mode wrap each `NavLink` in `<Tooltip label={entry.label} side="right">` (300ms delay, `bg-[--text] text-inverse` 12/16, 4 8 padding). |
| G10 | P2 | There is no "Skip to content" link. Tab passes through 8 sidebar links and 4 top bar controls before reaching the page. | `AppShell.tsx` | Add `<a class="sr-only focus:not-sr-only" href="#main">Skip to content</a>` as the first child, and give `<main id="main" tabIndex={-1}>`. |
| G11 | P2 | Ids are raw database ids everywhere: `alr_jsDeAChkCFWu73` and strategy `AdqRGGTNjnFE`. DESIGN 8 specifies display ids `A-10482` and `stg_8Kq2Zr`. They are long, they are hard to read aloud in support, and they truncate badly (L3, L4). | breadcrumb, drawer title, stream sub-lines, approvals, strategy tag | Backend: add `displayId` (`A-` + a sequence per user) and prefix strategy ids with `stg_`. Front end: show `displayId` and keep the raw id in `title` and in Copy ID. |
| G12 | P2 | `.pill` inherits letter-spacing from its container, so pills in the page title get `-0.3px` (alert detail title pill). | `styles/app.css` `.pill` | Add `letter-spacing: normal;` to `.pill`, `.tag` and `.mkt` (the chip keeps `0.02em`). |

## Top bar

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| T1 | P2 | Head block "n/a" (known). Mostly fixed: it now uses the heartbeat's `headBlock`. It still reads `n/a` (and Equity, Today and Loss stop read `n/a / n/a`) while the stream reconnects or before the first health payload. `n/a` means unknown, not loading. | `TopBar.tsx` `HeadItem`, Equity, Today, Loss stop items | While loading, or for up to 5 s without data, render a 48x12 `Skeleton` in place of the value. After that, hide the Head item entirely when `number === null` instead of showing `n/a`. |
| T2 | P2 | The connection popover shows raw enum values in lowercase: "live", "connected", "sim". Shot 06. | `TopBar.tsx` `ConnectionPill` `.conn-pop` | Map them to sentence case: Live, Connected, Reconnecting, Disconnected, Not set up. Mode: "Simulated" / "Testnet". Heartbeat: "0.5 s ago" → "now" when under 2 s, per DESIGN 8 relative time. |

## Live (`/live`)

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| L1 | P1 | Ignored (duplicate) rows read "Alert n/a · n/a · n/a · Alert n/a": three n/a values in one row. Every duplicate in the demo looks broken. Shot 03. Prototype: the duplicate keeps its signal "↗ Long BTC 0.050 · $5,595". | `pages/live/StreamRow.tsx:51-58` | For duplicates, show the original alert's side, market, size and price (the server knows `duplicateOf`; expose it on the DTO), or parse them from the raw payload. If nothing is known, render one muted "Duplicate delivery" in the Signal cell and leave the size line empty. Never stack `n/a · n/a`. |
| L2 | P1 | When loading alerts fails, the KPIs show confident zeros: "Alerts today 0, 0 filled · 0 blocked · 0 missed" next to the "Could not load alerts" error. Shot 10. | `pages/live/LivePage.tsx` KPI block, `pages/live/stats.ts` | When the alerts query `isError`, render every tile value as `n/a` (faint) with the sub-line "Could not load", and keep the filter counts hidden. |
| L3 | P1 | The duplicate sub-line truncates the raw id mid-string: "Duplicate of alr_fXS7eJLw7FJ…". | `lib/alert-view.ts:204` | Use the display id (G11). Until then, shorten as `alr_fXS7…7FJ` (6+3), which reads as an id and not as a cut-off sentence. |
| L4 | P1 | Tablet (1024): the Median slippage sub-line is clipped mid-word: "your cap is 50.0 bp". Shot 07. | `LivePage.tsx:191`, `.kpi-sub` | Let `.kpi-sub` wrap (`white-space: normal`), and shorten the copy to "vs alert price · cap 50 bps". |
| L5 | P1 | The stream header keeps showing the green "Live" dot when the app is Offline or Reconnecting (the banner and top bar pill are correct). Shot 11. | `LivePage.tsx` stream `CardHeader` | Bind it to `useStreamStatus()`: live → `Live` (positive dot, pulsing); reconnecting → `Reconnecting` (warning dot, pulsing); offline → `Paused` (faint dot, no pulse). |
| L6 | P2 | An in-flight close row shows "Close long BTC / n/a · n/a" until the fill arrives. Shot 04, frame 02. | `StreamRow.tsx:54` | For closes with unknown size, the sub-line should read "Whole position" (muted). |
| L7 | P2 | While loading, the filter counts read "All 0 · Filled 0 · Blocked 0 · Missed 0", the Open positions tag reads "0" and the footer reads "Margin used n/a of n/a equity". Shot 09. | `LivePage.tsx`, `pages/live/Tables.tsx` | Hide the `.c` counts and the count tag until the data has loaded, and render the foot values as `Skeleton` inline bars (40x12). |
| L8 | P2 | The cap is shown as "50.0 bps". DESIGN 12 says numbers in copy follow section 8 (`30 bps`). | `LivePage.tsx:191` | Use `formatBps(cap, { decimals: 0 })` (add the option), or `${cap} bps`. Same for Limits "Default slippage … / 50 bps" and Report "cap 50 bps". |
| L9 | P2 | Price improvement in the stream sub-line ("111,804.3 · −0.3 bps") is muted, while Recent fills colors the same value positive. | `StreamRow.tsx` outcome sub-line | Apply `slippageTone()` → `text-positive-text` for the bps part only, with `title="Filled 0.3 bps better than the alert price"`. |
| L10 | P2 | Recent fills Slippage turns `n/a` whenever the alerts query is not loaded, because it is derived from alerts. Shot 10. | `pages/live/Tables.tsx` | Compute from the fill record (`fill.price` vs `alert.price` on the fill or order DTO), or ask the backend for `slippageBps` on `FillDTO`. |
| L11 | P2 | Motion check: the row-in (accent-subtle held for about 1 s, then a 0.6 s fade, 1.6 s total), the active sheen on the in-flight stage and the 180ms fill on Filled all match DESIGN 6. Shot 04. Earlier stages arrive already done, because the server finishes them in under 1 ms before the SSE event, which is acceptable. One bug: `data-animate="fill"` is never cleared and stays on the final segment indefinitely, so any re-mount replays the fill. | `components/ui/LifecyclePipeline.tsx` | Clear `data-animate` on `animationend` (or after 200 ms), per DESIGN 6.1 "for one render". |

### Alert drawer (row click on Live)

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| D1 | P1 | The drawer title does not truncate (known), and 15px is off the type scale. A longer id or external id pushes the close button out. | `styles/app.css:969-970`, `LivePage.tsx:308` | `.drawer-head h2 { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; line-height: 24px; }`. Put the id in `title`. |
| D2 | P1 | Closing orders say "**1 of 6 checks passed.** Under the approval threshold, sent without waiting." It reads like five checks failed. Shot 13. | `pages/alert/timeline.tsx:54-58` | When `isClose`: title "Risk checks passed", description "Closing order. Only the strategy check applies, limits on new exposure are skipped." When not a close, keep "6 of 6". |
| D3 | P2 | The drawer is not deep-linked. The URL stays `/live`, so refresh or share loses it, and Back does not close it. | `LivePage.tsx` `openId` state | Mirror `openId` to `?alert=<id>` with `replace: false`. Open from the param on load and close on popstate. |

## Alert detail (`/alerts/:id`)

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| A1 | **P0** | For alerts that stopped before Checked (invalid message, duplicate, bad secret), Risk checks shows **"5 passed"** with green ticks for Strategy enabled, Market allowed, Max position size, Max leverage and Daily loss stop, none of which were evaluated. It also reads "**n/a is on your list**". This is false evidence on the screen meant to prove safety (principle 4). Shots 16, 18. | `pages/alert/derive.ts` `riskChecks()` (`stateFor` defaults to `"pass"` when `reason` is not in `ORDER`) | When `!reachedRisk && failIdx < 0`, set every row to `state: "skip"`, `value: "n/a"`, detail "Not reached, the alert did not pass verification". Card meta: "Not checked". Only show `${market} is on your list` when `market` is known. |
| A2 | P1 | The order frame contradicts its own comment: `"p": 4103.79, // alert + 50 bps cap`, while alert 4,101.62 + 50 bps = 4,122.13. The value equals the fill price. Either the limit price or the comment is wrong. The prototype frame matches its arithmetic (112,031.0 + 30 bps = 112,367.1). Shot 14. Same for "Limit price 4,103.79" in the Order card. | `pages/alert/frame.ts` (comment), server order builder (value) | Show what the executor actually sent. If the sim fills at the limit, the limit must still be alert ± max slippage. If the server sends the mark, change the comment to `// mark at send` and the Order card label to "Limit price (mark at send)". |
| A3 | P1 | Non-traded alerts are titled "Alert n/a", with Alert price `n/a` and Order notional `n/a`, while the raw payload right below shows `action: "short"`, `market: "BTCUSDT.P"`, `size_usd: 1100`, `price: 108557.81`. Shots 16 to 18. | `AlertDetailView.tsx` header and KPIs, `derive.ts` `parsedOf` | Fall back to best-effort fields from the raw payload for display, labeled honestly: title "↘ Short BTC" (the side from `action` or `market_position`), KPI sub-line "From the message, not verified". Keep `n/a` only for fields absent from the payload. |
| A4 | P1 | The failed alert callout is missing a sentence break: "Order rejected by Perpl It passed all 6 checks…". The reason is also generic, where DESIGN says "Perpl: insufficient margin". Shot 17. | `pages/alert/narrative.tsx:99` | `` `${msg.trim().replace(/[.]?$/, ".")}` ``, and surface the Perpl status text (`mt 26`/error code) from the server. |
| A5 | P2 | The Max position size check shows "Order notional $1,200 / $5,000". The limit applies to the position after the order (prototype "Position after this order $7,844 / $25,000"). | `derive.ts` (Max position size row) | Server: include `resultingPositionUsd` in the `risk_checked` event detail. Front end: label "Position after this order". |
| A6 | P2 | The Daily loss stop row uses the account's loss right now, not the loss at decision time, so historical alerts show today's number (or n/a when not today). | `derive.ts` (Daily loss stop row) | Server: snapshot `dailyLossUsd` in `risk_checked` detail and render that value. |
| A7 | P2 | Leverage formats disagree: the callout says "asked for 25x", the check row says "25.0x / 10x". | `derive.ts` `formatLeverageX(lev, { decimals: 1 })` | Use integers when the value is whole: `25x / 10x`. Keep 1 decimal for fractional values (`2.5x`). |
| A8 | P2 | The mono price KPI (22px) has no tracking. Prototype: `-0.02em` (-0.44px). | `.kpi-value.mono` in `app.css` / `alert.css` | `letter-spacing: -0.02em` on the mono variant too. |
| A9 | P2 | The Perpl messages row reads "Order placed · IOC" with no `oid`, and there is no `mt 3` (forwarded) row. The prototype shows `oid 7,302,118` and four messages. | server serializer, `AlertDetailView.tsx` messages table | Render `oid` when present. Backend: record `mt 3` in the sim so the timeline description matches ("Forwarded (mt 3), then placed…"). |

## Strategies (`/strategies`, `/strategies/:id`)

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| S1 | P1 | When the strategies request fails, the list shows skeleton rows forever, with no error or retry. Shot 20. | `pages/strategies/StrategyList.tsx` | On `isError`: `EmptyState` with icon `circle-alert`, title "Could not load strategies", body "Hermes did not respond. Your webhooks still work.", action "Retry". |
| S2 | P1 | Order settings is missing **Order type** ("Limit, immediate or cancel", hint "Fills now at the limit price or better, cancels the rest.") and **Max slippage** (`30 bps`, hint "Limit price = alert price + 30 bps for buys, minus for sells."). The Connect foot is missing "Last test … filled in 544 ms · A-10466" and "Dry run: stop after risk checks". Shot 19. | `pages/strategies/StrategyDetail.tsx`, `ConnectBody.tsx` | If slippage is per strategy on the server, add both fields in a `form-grid` 2-col (16 v, 20 h gaps). If it moved to Limits ("Default slippage"), add a read-only row "Max slippage 50 bps, from Risk limits" with a link, so traders can still see what each strategy will do. Add the Dry run `Checkbox` in the foot, right aligned. |
| S3 | P2 | The Recent alerts table puts the chip before the side ("BTC ↘ Short"). Everywhere else it is side then chip ("↘ Short BTC"). | `StrategyDetail.tsx` Recent alerts | Swap the order: `<SideLabel/> <MarketChip/>`. |
| S4 | P2 | `document.title` on `/strategies/:id` is "Strategies · Hermes". | `StrategiesPage.tsx` `PageHeader` | `"<strategy name> · Strategies · Hermes"`. |
| S5 | P2 | New strategy drawer: the Size placeholder "From the alert" is set in mono, and the leverage hint "Your risk limit caps this." drops the value. Shot 21. | `NewStrategyDrawer.tsx` | Set the placeholder in the sans face (only typed numbers are mono). Hint: "Your risk limit caps this at 10x." |

## Risk limits (`/limits`)

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| R1 | P1 | Market tiles show `n/a` for every mark without a position. See G7. | `LimitsPage.tsx` | See G7. |
| R2 | P2 | The Wallet policy card (DESIGN 10.6) is gone from this page. It now lives on Wallet and keys, but Limits is where traders look for "what stops a bad day". | `LimitsPage.tsx` | Add a one-line card under Limits: shield-check icon, "Wallet policy is enforced by Privy on every transaction.", link "See wallet policy" → `/wallet`. |
| R3 | P2 | Approval threshold is missing "Expire after [2 min ▾]" and the "Review the 2 waiting" link when approvals are waiting. Shot 22. | `LimitsPage.tsx` / `LimitRow.tsx` | Add both if the server has an approval TTL. If the TTL is fixed, add the static text "Expire after 2 min". |
| R4 | P2 | Typing an invalid value (0) feeds the usage meters: "$1,649 / $0" with a neutral meter. Shot 24. | `LimitRow.tsx` | Meters keep the saved value while a field is invalid. Over 100% renders the meter negative. |
| R5 | P2 | The card meta "Saved changes apply to the next alert" duplicates the field hint. Prototype: "Last changed 9 Oct, 21:14". | `LimitsPage.tsx` | Show `Last changed <date>` from `limits.updatedAt`. |
| R6 | P2 | On mobile, "Size 2 · Market 1 · Leverage 1" wraps and leaves an orphan "1". Shot 25. | `LimitsPage.tsx` KPI sub | Wrap each `label count` pair in `white-space: nowrap`. |

## Approvals (`/approvals`)

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| AP1 | P1 | "Mark now n/a / No open position to read it from" on the decision card. The trader needs this to decide. Shot 26. See G7. | `ApprovalsPage.tsx:223-226` | See G7. |
| AP2 | P2 | The sub-line copy pair is asymmetric: "better for a buy" vs "better for a short". | `ApprovalsPage.tsx:226` | "better for a long" / "better for a short", matching the side labels. |

## Report card (`/report`)

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| C1 | P1 | The grade no longer matches DESIGN 10.8, which is copy "exactly as shown to the user". Four parts instead of three (Fill rate 35, Slippage 25, Latency 20, Reliability 20; "Latency", not "Speed"). The footer now says "Blocked, expired and failed alerts count against the fill rate", which reverses the founding rule "a block you asked for never lowers the grade". Shot 27. | server `reports/report-card.ts` (being edited), `pages/report/GradePanel.tsx`, `MissedCard.tsx` footer | Product decision needed before the demo. The design position: keep blocks excluded from eligible alerts. If Reliability stays, rename the parts to Fill rate, Slippage, Speed, Reliability, and rewrite the explanation in DESIGN's register (short sentences, one formula line) instead of the current 9-line paragraph. Footer back to "Blocked and ignored alerts do not count against the grade." |
| C2 | P2 | Blocked and missed is missing the **Last** column (mono `11 Oct`, right aligned). Shot 28. | `pages/report/MissedCard.tsx` | Add the column (`numeric`, `hideSm`), formatted with `formatTableTime` (date for older than today). |
| C3 | P2 | One 9.21 s outlier sets the latency y axis to 0 to 10 s and flattens every other point. The annotation has no reason, where the prototype shows "1.42 s · Perpl reconnect". | `pages/report/Charts.tsx` | Y max = `max(1.5 s, p95_max × 1.2)`. Draw outliers above the max as a clipped point with a 3px up-chevron and the label "9.21 s · <cause>" (cause from the bucket's worst alert: reconnect, retry, slow fill). |

## Wallet and keys (`/wallet`)

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| W1 | P1 | The gap between card rows is 36px (16 inline `marginBottom` + 20 content gap). Everywhere else it is 16. Shot 30. | `pages/wallet/WalletPage.tsx:328,332` | Remove `marginBottom: 16` from both `grid-12` wrappers. |
| W2 | P1 | Policy check rows label refusals "**Blocked**" (in mono, muted) next to **green ticks**, before any check has run. DESIGN 12: "blocked" is only for Hermes limits. The green tick also implies a test passed. | `WalletPage.tsx:250-253`, `parts.tsx:217` | Value → outline pill neutral "Refused". Icon → `shield-check` muted until a check runs; after a run, `circle-check` positive with "Refused by Privy, as expected". `parts.tsx:217`: "**Refused by your wallet policy:**". |
| W3 | P2 | The "Policy check" button repeats the card title. | `pages/wallet/parts.tsx:207` | "Run policy check". |
| W4 | P2 | Failed balance reads (blocked RPC) render as `n/a MON` at the 24px KPI size, which looks broken. Also seen on onboarding step 1. Shot 30. | `WalletPage.tsx`, `onboarding/StepWallet.tsx` | Show `n/a` at 13px faint, with the sub-line "Could not read the balance" plus a ghost sm "Retry". |

## Onboarding (`/onboarding?step=1..4`)

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| O1 | P1 | Step 2 transaction rows use numbered circles and plain buttons ("Get AUSD", "Approve", then disabled "Create account" and "Allow", which read as plain text). DESIGN specifies a status circle, title, meta with block and tx link, and a status pill (Not started / Waiting for signature / Pending / Confirmed / Failed / Refused by policy). Shot 33. | `pages/onboarding/StepAccount.tsx` | Keep the action button for the next row only. Every other row gets its status pill (`Confirmed` positive, `Pending` accent with live dot, `Not started` neutral). Done rows show "Confirmed in block 41,820,114 · 0x3b9e…77a1 ↗". |
| O2 | P2 | Step 2 stacks five cards (connected callout, deposit, four tx rows, policy callout, Policy check, Use a simulated account), about 850px of content for one decision. | `StepAccount.tsx` | Move "Policy check" and "Use a simulated Perpl account" into a ghost disclosure "More options" under the policy callout. |
| O3 | P2 | Step 1 repeats the full signer and policy key-value table from Wallet (7 rows), which doubles the page height. Shot 32. | `StepWallet.tsx` | Keep the one-paragraph explanation and the "Allow Hermes…" button. Put the table behind "See the policy" (ghost sm, expands inline). |
| O4 | P2 | Step 3: the verified row meta wraps and starts its second line with a separator: "· simulated · collateral $9,997.36". Shot 34. | `StepKey.tsx` | Drop "key pk_sim_…" from the meta (it is in Wallet), or render the parts as nowrap spans joined by ` · ` so separators never start a line. |
| O5 | P2 | Step 4 primary buttons are `md`. DESIGN 10.2: "Send test alert secondary lg, Go to Live primary lg". | `StepStrategy.tsx` | `size="lg"` on both. |

## Landing (`/`)

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| N1 | P2 | Matches the prototype (shot 36). The signed-in variant ("Open Hermes") and the "Example numbers from a demo strategy." caption are good additions. One nit: the relay card meta "Alert A-10482" uses a display id the app itself never shows (G11). | `pages/landing/RelayCard.tsx` | Leave as is, but align once G11 lands. |

## Components (`/components`)

| # | Sev | What is wrong | Where | Fix |
|---|---|---|---|---|
| K1 | P2 | The pipeline gallery shows 4 states. Missing: Needs approval (waiting), Rejected by Perpl, Ignored, Expired, Skipped. These are the states that regressed elsewhere (A1, L1). | `pages/Components.tsx` | Add the five rows, built from real `alertPipeline()` fixtures, not hand-set states. |
| K2 | P2 | The outline pills (Connected, Reconnecting, Offline) show the G2 double ring. Shot 31. | | Fixed by G2. |

---

## Checked and fine (no action)

- Tokens and type: the page title is 20/28 600 -0.015em, KPI values are 24/500 -0.02em, the table header is 32px at 12/500 muted, rows are 40 / 56 (stream), nav items are 32 with 10 padding, pills are 22 with 0 8 0 7 padding. All measured identical to the prototype.
- Copy: no em or en dashes on any route, U+2212 on every negative, sentence case throughout, the Pause trading and Rotate secret modals match DESIGN word for word.
- Focus ring (2px canvas + 2px accent) on every tabbable element except G4. Button hover goes from raised to active with the strong border at 120ms. Row hover is `--surface-hover`.
- Drawer and modal: New strategy is 480 wide and focuses the first field. The modals are 440 wide with focus on Cancel. Escape closes all of them.
- Responsive: no horizontal scroll at 390 on any route. The rail at 1024 and Head hidden below 1280 are correct. Mobile stream cards match the prototype.
- Light theme on every route (shot 38).

## How this was run

Server bundled from the working tree to a scratch directory (`tsup`), run with `AUTH_MODE=dev` on :8797 against a scratch DB. Vite on :5183 with `HERMES_API_URL`. `demo:alerts` ran throughout, and two over-threshold webhooks were posted to create approvals. The capture scripts are Playwright (Chromium) runs, and the states were produced with `page.route` interception (delay, 500, empty lists, SSE abort).
