# Hermes design system

The spec the React app is built from. If this document and the prototype disagree, the prototype wins on pixels and this document wins on behavior and copy.

| What | Where |
|---|---|
| Tokens (CSS variables, Tailwind v4 `@theme`, base styles) | `apps/web/src/styles/tokens.css` |
| Component CSS that is cleaner outside Tailwind (pipeline, skeleton, keyframes, JSON colors) | `apps/web/src/styles/components.css` |
| High-fidelity prototype, one file per screen | `design/prototype/*.html` (start at `index.html`) |
| Prototype-only component classes (reference values for Tailwind) | `design/prototype/prototype.css` |
| App shell markup (sidebar, top bar), JSON highlighter, pipeline helper | `design/prototype/prototype.js` |
| Screenshots, 1440x900 and 390x844, dark and some light | `design/screenshots/` |

Open any prototype page with `?theme=light` for the light theme, `?step=1..4` on `onboarding.html`, and `?freeze` to stop animations.

---

## 1. Brand rationale

Hermes is a relay. A signal comes in from TradingView, an order goes out to Perpl, and the trader needs to know, to the millisecond and the basis point, what happened in between. The interface is an **instrument panel**: dark, quiet, dense and exact. It should feel like Linear's restraint applied to a Hyperliquid level of numeric density.

Principles, in priority order:

1. **Numbers are the hero.** Every price, size, latency and hash is set in Geist Mono with tabular figures, right aligned in columns, with consistent decimals. Chrome recedes so numbers can lead.
2. **Color means state, never decoration.** The UI is neutral grey. Color appears only when it carries meaning: green and red for money and outcomes, amber when one of the trader's limits acted, blue for things in motion. No gradients, no glows, no purple.
3. **Never color alone.** Every colored value also has a sign, an arrow, an icon or a word: `+$22.05`, `↗ Long`, `⊗ Blocked`.
4. **Show the mechanism.** Every alert shows its six-stage lifecycle with timings. Every block shows the limit and the value that tripped it. Every onchain action links to the explorer. Trust comes from visible evidence.
5. **Plain words.** Short sentences, no hype, no em-dashes (see section 12).

**Logo.** A 22px rounded square (radius 6) filled with `--text`, holding an "H" whose crossbar continues into an arrow: alert in, order out. Stroke 1.9 in `--canvas`. SVG in `prototype.js` (`MARK`). The wordmark is "Hermes" in Geist 600, 14px, tracking -0.01em. Never recolor the mark with the accent.

---

## 2. Color

All colors are CSS variables in `tokens.css`. Dark is the default (`:root`); light applies under `<html data-theme="light">`. Theme choice is stored in `localStorage` key `hermes-theme` (wrap reads and writes in try/catch) and applied before first paint to avoid a flash.

### 2.1 Tokens

| Token | Dark | Light | Use |
|---|---|---|---|
| `--canvas` | `#0b0c0e` | `#f5f6f8` | Page, sidebar, top bar |
| `--surface` | `#111316` | `#ffffff` | Cards, tables, drawers |
| `--surface-raised` | `#171a1e` | `#ffffff` | Secondary buttons, popovers, modals, toasts |
| `--surface-sunken` | `#0d0f11` | `#f3f4f6` | Inputs, code blocks, segmented track |
| `--surface-hover` | `#181b1f` | `#f4f5f7` | Row and item hover |
| `--surface-active` | `#1f2328` | `#eceef1` | Selected nav item, chips, pressed |
| `--overlay` | `rgb(5 6 8 / .72)` | `rgb(15 18 22 / .40)` | Modal and drawer scrim |
| `--border-subtle` | `#1c1f24` | `#ebedf0` | Card borders, row dividers |
| `--border` | `#262a30` | `#e0e3e7` | Inputs, chips, secondary buttons |
| `--border-strong` | `#353a42` | `#c9ced5` | Hover borders, unchecked controls |
| `--text` | `#eceef0` | `#0d0f12` | Primary text and numbers |
| `--text-secondary` | `#a4a8b0` | `#4b515a` | Body copy, secondary values |
| `--text-muted` | `#7d828b` | `#666c76` | Labels, captions, column headers |
| `--text-faint` | `#565b64` | `#a0a6ae` | Disabled, placeholders, "n/a" only |
| `--primary` / `--primary-fg` | `#eceef0` / `#0b0c0e` | `#0d0f12` / `#ffffff` | Primary button (neutral, not a hue) |
| `--accent` | `#4d8eff` | `#2563eb` | In-flight state, focus ring, toggles, chart series |
| `--accent-text` | `#80b1ff` | `#1f58d6` | Links, accent text |
| `--positive` / `--positive-text` | `#30c48d` / `#4dd6a2` | `#0b8f5c` / `#087a4e` | Profit, filled, passed |
| `--negative` / `--negative-text` | `#f0565c` / `#ff7d82` | `#d32f37` / `#bb232b` | Loss, failed, not filled |
| `--warning` / `--warning-text` | `#e8a23a` / `#f2ba62` | `#b86e00` / `#965900` | Blocked by a limit, near a limit |
| `--*-subtle` | 12% of the hue | 7 to 8% | Pill and callout backgrounds |
| `--*-border` | 32 to 36% | 28 to 30% | Callout and outline-pill borders |
| `--pipe-done` | `#9a9fa8` | `#a3a9b1` | Completed pipeline segment |
| `--chart-1` | accent | accent | The one data series |
| `--chart-2` | `#8a8f98` | `#8b919a` | Secondary series (p95), de-emphasis |
| `--chart-grid` / `--chart-axis` | `#1c1f24` / `#2c3036` | `#eceef1` / `#d5d9de` | Hairline gridlines and baseline |
| `--syntax-*` | key `#9fb6d9`, string `#c3d0a0`, number `#e2b58a`, literal `#c9a6d8`, punct `#5f646d` | darker equivalents | JSON in code blocks. Desaturated so it never reads as status |

### 2.2 Rules

- **Text on color uses the `-text` variant**, never the base hue: `text-positive-text`, not `text-positive`. Base hues are for fills (dots, bars, segments, toggle tracks).
- **Measured contrast (WCAG):** `--text-muted` is 4.8:1 on dark surface and 5.3:1 on white. Every `-text` variant is at least 4.9:1 on its surface in both themes. `--text-faint` (2.7:1) is never used for information a user needs.
- **Semantic map, used everywhere:**
  - Filled, passed, profit, connected: positive
  - Not filled, rejected by Perpl, failed, loss, offline: negative
  - Blocked by your limit, near a limit (80%+), reconnecting, expiring soon (under 60 s): warning
  - In flight, needs approval, focus, links, selection: accent
  - Ignored (duplicate), expired, off, skipped: neutral grey
- **Long and Short** are positive and negative text with `arrow-up-right` / `arrow-down-right`. "Close long" and "Close short" are neutral with `minus`.
- **Primary actions are neutral** (`--primary`). The accent never fills a large area. White text on the dark-theme accent fails contrast, so there is no solid accent button.
- **One accent per view at most** for decoration-free emphasis; status colors may repeat because they are data.

### 2.3 Tailwind utilities

`tokens.css` clears Tailwind's default palette (`--color-*: initial`) and maps only Hermes tokens, with `@theme inline` so the utilities follow the theme at runtime:

| Utility | Token |
|---|---|
| `bg-canvas` `bg-surface` `bg-raised` `bg-sunken` `bg-hover` `bg-active` `bg-overlay` | surfaces |
| `border-subtle` `border-line` `border-strong` | lines |
| `text-fg` `text-secondary` `text-muted` `text-faint` `text-inverse` | text |
| `bg-primary` `text-primary-fg` `hover:bg-primary-hover` | primary button |
| `text-accent-text` `bg-accent-subtle` `border-accent-border` `bg-accent` | accent |
| `text-positive-text` `bg-positive-subtle` `border-positive-border` `bg-positive` (same for `negative`, `warning`) | semantics |
| `text-positive` | allowed for icons only |
| `font-sans` `font-mono` | Geist, Geist Mono |
| `shadow-1` `shadow-2` `shadow-3` | elevation |
| `ease-out` `ease-in-out` | motion |
| `animate-pulse-ring` `animate-shimmer` `animate-row-in` `animate-spin` | motion |

Note `border-line`, not `border` (that name is taken by the width utility). There is no `bg-white`/`text-white` in product UI; `white` exists only for the toggle knob.

---

## 3. Typography

### 3.1 Fonts

| Role | Family | npm package | Import |
|---|---|---|---|
| UI | Geist (variable, 100 to 900) | `@fontsource-variable/geist` | `import "@fontsource-variable/geist";` family name `"Geist Variable"` |
| Numbers, code, hashes, timestamps | Geist Mono (variable) | `@fontsource-variable/geist-mono` | `import "@fontsource-variable/geist-mono";` family name `"Geist Mono Variable"` |

Import both in `main.tsx` before `index.css`. The token stacks already list `"Geist Variable", "Geist"` so the prototype (Google Fonts) and the app (fontsource) resolve the same face. Weights used: 400, 500, 600 only.

### 3.2 Scale

Body UI text is 13px. Tailwind classes follow `tokens.css`.

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `text-2xs` | 11 / 16 | 400 to 500 | Captions, pipeline ms, sub-lines in tables, tick labels |
| `text-xs` | 12 / 16 | 400 to 500 | Labels, column headers, hints, meta, pills |
| `text-sm` | 13 / 20 | 400 to 600 | **Default.** Body, table cells, nav, buttons, card titles (600) |
| `text-base` | 14 / 20 | 500 to 600 | Emphasized values, landing body |
| `text-md` | 16 / 24 | 600 | Modal titles, strategy name, mono values in approval cards |
| `text-lg` | 20 / 28 | 600, tracking -0.015em | Page titles (18 / 24 on mobile) |
| `text-xl` | 24 / 32 | 500, tracking -0.02em | KPI values (20 / 28 on mobile), onboarding titles |
| `text-2xl` | 32 / 40 | 600 | Landing section titles use 28 / 36 |
| `text-3xl` | 48 / 52 | 600, tracking -0.035em | Landing hero is 52 / 56 desktop, 36 / 40 mobile |

Rules:
- Sentence case everywhere: titles, buttons, labels, column headers. No uppercase labels, no letter-spaced caps.
- **Mono for every number that can change or be compared**: prices, sizes, notionals in tables, latencies, bps, block numbers, hashes, ids, timestamps, countdowns. Mono size is one step below the surrounding sans (12px mono in 13px rows) because Geist Mono sets visually larger.
- KPI tile values use **Geist sans 24 / 500** with proportional figures, and a muted 14px unit (`486` `ms`). Exception: prices as KPI values (alert detail) use mono 22px so the decimals match the tables.
- Columns of numbers use `tabular-nums` (mono already is) and are right aligned. Do not enable the `zero` feature; Geist Mono's 0 is distinct enough and slashed zeros are noisy in dense tables.
- Max line length for prose: 560px (about 70 characters).

---

## 4. Spacing and layout

### 4.1 Grid

4px base. Tailwind's default `--spacing: 0.25rem` is the grid, so `p-1` = 4px. Allowed steps: 2 (hairline offsets only), 4, 6 (icon gaps), 8, 10 (nav padding), 12, 16, 20, 24, 32, 40, 48, 56, 72, 96.

| Context | Value |
|---|---|
| Card padding | 16 (12 on mobile KPI tiles) |
| Card head height | min 44, padding 8 / 16 |
| Gap between cards | 16 |
| Gap between page sections | 20 desktop, 16 mobile |
| Page gutter | 24 desktop, 16 at < 768 |
| Table cell | 0 / 12 horizontal, 16 at row edges |
| Form field: label to control | 6 |
| Form grid gap | 16 vertical, 20 horizontal |

### 4.2 Shell

| Element | Spec |
|---|---|
| Sidebar | 232 wide at >= 1280; 56 icon rail at 768 to 1279; off-canvas drawer 272 wide at < 768 (menu button in top bar, scrim closes it) |
| Top bar | 48 high, sticky, `--canvas` at 88% with 8px backdrop blur, bottom hairline. At < 768 it grows a second row: a 3-column status strip |
| Content | max width 1440, centered, padding 24 / 24 / 48 |
| Breakpoints | Tailwind defaults: `md` 768, `lg` 1024, `xl` 1280. Extra stop at 1100 for the alert stream (strategy column hides) and card grids (12-column spans collapse to full width) |

The 12-column content grid (`grid-cols-12 gap-4`) is used for card layouts: dashboard 7/5, alert detail 8/4, report 4/8 then 6/6.

---

## 5. Radius and elevation

| Token | px | Use |
|---|---|---|
| `rounded-xs` | 4 | Market chips, tags, checkboxes, segmented items, skeleton bars |
| `rounded-sm` | 6 | Buttons, inputs, nav items, segmented track |
| `rounded-md` | 8 | Cards, tables, code blocks, callouts, market tiles; `btn-lg` and `input-lg` |
| `rounded-lg` | 12 | Modals, feature tiles; toasts and popovers use 10 |
| `rounded-xl` | 16 | Landing relay visual only |
| `rounded-full` | | Pills, dots, avatars, toggles, meters |

Elevation. Dark UI separates layers with borders, not shadows.

| Level | Token | Use |
|---|---|---|
| 0 | none, 1px `--border-subtle` | Cards, tables |
| 1 | `--shadow-1` | Cards (a 2% inner highlight in dark, a 4% drop in light) |
| 2 | `--shadow-2` | Popovers, menus, toasts, sticky save bar |
| 3 | `--shadow-3` | Modals, drawers, landing relay card |

---

## 6. Motion

| Token | Value | Use |
|---|---|---|
| `--dur-instant` | 80ms | Button press nudge |
| `--dur-fast` | 120ms | Hover color and border changes |
| `--dur-base` | 180ms | Toggles, segment fill, tab underline |
| `--dur-slow` | 280ms | Drawer, toast and modal entrance, mobile nav |
| `--dur-slower` | 420ms | Large layout changes (rare) |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | Default for everything entering or changing |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` | Looping pulses |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Exits (use 120ms) |

What animates, and only this:

1. **Pipeline stages** (signature motion). A stage that is in progress gets `data-state="active"`: its segment shows a moving accent sheen (`hm-seg-active`, 1.1s linear loop) and its ms label reads `…`. When the stage completes, set `data-state="done"` and `data-animate="fill"` for one render: the segment fills left to right in 180ms. The final Filled stage turns positive. Blocked or failed stages snap to amber or red without a sheen; later stages become `skipped`. Drive this from WebSocket status, never from timers.
2. **New alert row**: `animate-row-in` (slides 6px down, accent-subtle background fading out over 1.6s).
3. **Live values** (equity, PnL, mark): apply `hm-flash-up` or `hm-flash-down` for 900ms when the value changes direction. Never animate the digits themselves.
4. **Live dots**: `data-live="true"` pulses opacity on a 2s loop. Only on things that are genuinely live (stream header, in-flight pill, reconnecting).
5. **Countdown meters** drain linearly once per second.
6. **Skeleton shimmer**, 1.6s linear.
7. Overlays: drawer slides 16px from the right, modal rises 8px and scales from 0.98, toast rises 8px; all 280ms ease-out. Scrim fades 180ms.

`prefers-reduced-motion: reduce` collapses all of the above to 1ms (in `components.css`); state changes still happen, the active pipeline segment becomes solid accent.

---

## 7. Iconography

- **lucide-react** only. 16px in UI (stroke 1.75), 14px in small buttons and inline meta, 12px inside pills (stroke 2.25) and KPI labels, 20px in empty states (stroke 1.6). Icons inherit `currentColor`.
- Icons accompany labels; icon-only buttons need `aria-label` and a tooltip.
- No emoji, no coin logos, no brand marks. Markets are text chips (`BTC`).
- Canonical icons (kebab-case names as in `design/prototype/icons.js`; PascalCase in lucide-react):

| Meaning | Icon |
|---|---|
| Live (nav) | `activity` |
| Strategies, webhook | `webhook` |
| Approvals, needs approval | `hand` |
| Risk limits | `shield`; wallet policy `shield-check` |
| Report card | `chart-column` |
| Wallet and keys | `key-round`; wallet `wallet` |
| Long / Short / Close | `arrow-up-right` / `arrow-down-right` / `minus` |
| Filled, passed | `circle-check` |
| Blocked by a limit | `octagon-x` |
| Not filled, rejected | `circle-x` |
| Ignored duplicate | `copy` |
| Expired | `hourglass` |
| Timer, countdown | `timer` |
| Send test alert | `send` |
| Copy / done | `copy` / `check` |
| Reveal secret | `eye` / `eye-off` |
| Rotate secret | `refresh-cw` |
| External link (explorer) | `arrow-up-right` at 12px after the text; `external-link` on buttons |
| Pause trading | `circle-pause` |
| Disconnected | `wifi-off` |
| Faucet | `droplet` (MON), `coins` (AUSD) |
| Loading | `loader-circle` spinning |

---

## 8. Data formatting

Implement these once in `src/lib/format.ts`; never format inline.

| Value | Rule | Examples |
|---|---|---|
| Price | Decimals from the market's tick size in Perpl `pub/context`. Fallback: BTC 1, ETH 2, SOL 3, MON 6, ZEC 2. Thousands separators. No currency sign on prices | `112,048.5` `4,098.62` `210.412` `0.040118` |
| Size | Base units, market lot decimals. Fallback: BTC 3, ETH 2, SOL 1, MON 0, ZEC 1 | `0.050` `1.20` `140.0` `150,000` |
| USD amount | `$` + 2 decimals in tables and detail. Tiles and summaries may drop cents at >= $10,000 and compact at >= $1M (`$1.28M`) | `$5,602.43` `$29,458` |
| Signed money (PnL) | Always signed. Use U+2212 minus `−`, never a hyphen. Sign before the `$` | `+$22.05` `−$137.20` |
| Percent | 1 decimal; signed when it is a change | `91.2%` `+0.37%` |
| Slippage | bps, 1 decimal. **Positive means worse than the alert price.** Buy: `(fill − alert) / alert × 10,000`. Sell: `(alert − fill) / alert × 10,000`. Shown unsigned and neutral when worse (it is a cost, expected). Price improvement shows `−0.4 bps` in positive color with tooltip "Filled 0.4 bps better than the alert price". Over the strategy's max slippage: warning color | `1.6 bps` `−0.4 bps` |
| Latency | Integer ms under 1 s; `1.24 s` (2 decimals) at or above 1 s; stage deltas signed `+184 ms`; under 1 ms `<1 ms`; first stage `0 ms` | `612 ms` `1.42 s` `+4 ms` |
| Leverage | From `lv` (hundredths): `lv / 100`, 1 decimal plus `x`; limits show integers | `5.0x` `10x` |
| Absolute time | Local, 24h. Stream and timeline: `HH:mm:ss.SSS`. Tables: `HH:mm:ss`. Older than today: `11 Oct 22:31`. Show the zone once per view ("times in WAT (UTC+1)"), UTC on hover | `14:32:07.412` |
| Relative time | `now` (< 2 s), `12s ago`, `4m ago`, `3h ago`, then the date | `12s ago` |
| Countdown | `m:ss` | `1:42` `0:38` |
| Address, tx hash | `0x` + 4 + `…` (U+2026) + 4, mono. Full value in `title`, copy copies the full value | `0x7a3F…91c2` `0x8f3a…e21c` |
| Explorer links | `https://testnet.monadexplorer.com/tx/<hash>` and `/address/<addr>`, `target="_blank" rel="noopener"`, accent text with 12px `arrow-up-right` | |
| Block number | Thousands separators, mono | `41,822,907` |
| Perpl ids | `rq`, `sn`, order id with separators; message types as tag `mt 25` | `rq 1,904,233` |
| Hermes ids | Alert `A-10482`, strategy `stg_8Kq2Zr` | |
| Missing | `n/a` in `--text-faint`. Never `-`, `—` or `0` for unknown | `n/a` |

---

## 9. Components

Dimensions are exact. Prototype class in brackets; implement as React components with Tailwind utilities, using `components.css` where noted.

### Button `[.btn]`
- Heights: sm 28 (px 10, text 12, icon 14), md 32 (px 12, text 13, icon 16), lg 40 (px 16, text 14, radius 8). Gap 6. Weight 500. Icon-only: square (28 / 32).
- Variants:
  - `primary`: `bg-primary text-primary-fg`, hover `--primary-hover`. One per view region.
  - `secondary`: `bg-raised border-line`, hover `bg-active border-strong`.
  - `ghost`: transparent, `text-secondary`, hover `bg-hover text-fg`.
  - `danger`: `bg-negative-subtle border-negative-border text-negative-text`. Pause trading, delete.
  - `accent`: subtle accent, for rare positive-but-not-primary actions.
- States: hover, active (translateY 0.5px), focus-visible (`--focus-ring`: 2px canvas gap + 2px accent), disabled (45% opacity, no pointer), loading (leading `loader-circle` spinning, label becomes the gerund: "Saving").
- Optional keyboard hint: 11px mono at 60% opacity after the label (`Approve and send A`).

### Input `[.input]`
- Height 32 (lg 40, radius 8, text 14), px 10, radius 6, `bg-sunken border-line`. Hover `border-strong`. Focus `border-accent` + 3px `accent-subtle` ring. Error `border-negative` + 3px `negative-subtle` ring + message below (12px, `circle-alert` 12px).
- Affixes inside the field in muted 12px: `$`, `USD`, `bps`, `x`, `per market`. Numbers and keys use the mono variant (12px mono).
- Read-only copy field: value truncates with ellipsis, trailing ghost `Copy` button (sm). After copy: icon becomes `check`, label "Copied" for 1.4 s.
- Secret field: masked `••••••••••••••••••••hx2K` (last 4 visible), reveal and copy icon buttons, `Rotate` secondary button outside the field.
- Label 12/500 secondary above; hint 12 muted below.

### Select `[.input.select]`
Same box as Input with a 14px chevron at the right. Use a Radix-style popover list (`--shadow-2`, radius 10, items 32 high). A select may hold a market chip before the label.

### Toggle `[.toggle]`
Track 30x18, knob 14 white with a small shadow, travel 12px, 180ms. Off `--border-strong`, on `--accent`. The global Trading switch uses `--positive` when on. Label at 12px secondary, left or right. Disabled 45%.

### Checkbox `[.check]`
16x16, radius 4, `bg-sunken border-strong`; checked `bg-accent` with a white check.

### Segmented control `[.seg]`
Track 32 high (28 in code heads), `bg-sunken border-subtle`, padding 2, radius 6. Items 26 high, px 10, text 12/500 muted; selected `bg-active text-fg` with 1px `--border` ring. Optional mono count after the label. Used for outcome filters, time ranges, size mode.

### Tabs `[.tabs]`
40 high, gap 20, text 13/500 muted; selected `text-fg` with a 2px `--text` underline (not accent). Horizontal scroll without scrollbar on mobile.

### Market chip `[.mkt]`
20 high, min width 36, px 6, radius 4, mono 11/600, `bg-active border-line`. Disabled market: muted text.

### Side label `[.side]`
`↗ Long` positive-text, `↘ Short` negative-text, `− Close long` (lucide `minus` icon) secondary. Icon 14, stroke 2, gap 4, weight 500.

### StatusPill `[.pill]`
22 high, radius full, padding 0 8 0 7, gap 6, icon 12, text 12/500, subtle background, no border (outline variant: transparent with `--border`, used in dense tables).

| Status | Tone | Icon |
|---|---|---|
| In flight | accent | live dot |
| Needs approval | accent | `hand` |
| Filled | positive | `circle-check` |
| Partly filled | positive | `circle-dot` |
| Blocked | warning | `octagon-x` |
| Not filled | negative | `circle-x` |
| Rejected by Perpl | negative | `circle-x` |
| Ignored | neutral | `copy` |
| Expired | neutral | `hourglass` |
| Connected / Reconnecting / Offline | outline with positive / warning (live) / negative dot | |

### Tag `[.tag]`
20 high, radius 4, 11/500 secondary on `bg-active`. Counts in card titles, `mt 25`, strategy ids.

### Card `[.card]`
`bg-surface border-subtle rounded-md shadow-1`. Head: min 44, padding 8 16, title 13/600 (nowrap), meta 12 muted, actions right; wraps on narrow widths. Body padding 16. Foot: min 40, padding 10 16, 12 muted, top hairline, wraps.

### KPI tile `[.kpis > .kpi]`
Tiles live in a single bordered strip (`bg-surface border-subtle rounded-md`) separated by 1px internal dividers, not as separate cards. Tile padding 14 16 16, gap 6. Label 12 muted. Value Geist 24/500 tracking -0.02em with a 14px muted unit (`95.3 %` renders as `95.3` + `%`). Sub-line 12 muted; a delta uses an arrow icon plus mono value in the semantic color. 4 per row (dashboard), 3 per row (report, landing), 2 per row on mobile with value 20/28.

### Table `[table.t]`
Header 32, 12/500 muted, sentence case, bottom hairline. Rows 40 (36 compact, 48 for two-line cells), 13px, hairline between rows, hover `bg-hover`. Numeric columns right aligned, mono 12. First and last cells padded 16. Clickable rows show pointer and navigate. Sub-lines 11 muted. On mobile hide secondary columns (marked in the prototype with `hide-sm`) rather than scrolling; the wrapper still allows horizontal scroll as a fallback.

### Pipeline / lifecycle stepper `[.hm-pipe]`, in `components.css`
The signature component. Six stages, always in this order and with these names: **Received, Verified, Checked, Sent, Accepted, Filled**.
- Anatomy per stage: segment (4px high, radius 2; `lg` 6px, radius 3), optional label (lg only, 12 secondary), ms delta (11 mono). Stages sit in a 6-column grid with a 2px gap. Width: 360 to 432 in the stream (column header carries the stage names once), full card width in detail.
- States (`data-state`): `pending` (`--border`), `active` (accent sheen, ms `…`), `done` (`--pipe-done`), `final` (positive, ms in positive-text), `blocked` (warning), `failed` (negative), `skipped` (`--border-subtle`, faint text).
- Delta per stage is time since the previous stage; the Total column is time from Received to the terminal stage.
- Accessibility: the group has `role="img"` and an `aria-label` listing each stage and state.
- Compact dot form for very narrow spaces: `.hm-pipe-dots` (6px nodes joined by hairlines).

### Timeline `[.tl]`
Rows in five columns: absolute time 104 (mono 12 muted) | node 20 (9px ring on a 1px rail; filled positive / warning / negative for terminal states) | title 13/500 + description 12 muted with inline mono ids | delta 72 right aligned (mono) | gantt 168 (2px track, 8px bar positioned at the stage's start offset with width proportional to its duration; final stage bar positive). An axis row underneath labels 0 and the total. On mobile: node | body (time moves under the description) | delta.

### Meter `[.meter]`
4px (lg 6) radius full, track `--border`, fill `--text-secondary` by default. Tone by usage: under 80% neutral, 80 to 99% warning, 100% negative. Countdown meters use accent, warning under 60 s. Optional 1px tick for a threshold (the 80% warning). Always paired with numbers: `$137.20 / $500`.

### CodeBlock `[.code]`
`bg-sunken border-subtle rounded-md`. Head 36: name 12/500 secondary, meta 11 mono muted, actions right (copy icon button, or a labeled `Copy message` secondary sm). Body padding 12 14, mono 12/20, horizontal scroll, never wraps JSON. Syntax colors from `.hm-code` classes (`k s n l p c v`); TradingView placeholders `{{close}}` are accent-text. Copying always copies the real value, including the real secret, even when the display is masked.

### Callout `[.callout]`
Padding 12 14, radius 8, 16px icon, 13/20 secondary text with the key sentence in 600 `--text`. Tones: neutral (raised surface), accent (info), positive (safety guarantees, success), warning (limit acted), negative (errors).

### Banner `[.banner]`
Full width under the top bar, 8 24 padding, warning or negative subtle background. For system state that affects every page: Perpl socket reconnecting, daily loss stop reached, trading paused.

### Drawer
Right side, 480 wide (100% on mobile), `bg-surface border-l shadow-3`, header 56 with title and close, footer with actions. Used for New strategy and the mobile nav. Escape closes; focus is trapped.

### Modal `[.modal]`
440 wide (max 100vw − 32), `bg-raised rounded-lg shadow-3`. Body padding 20, title 16/24 600, text secondary. Footer: padding 12 20, top hairline, actions right (Cancel ghost, confirm primary or danger). Used for destructive confirmations only (Pause trading, Rotate secret, Delete strategy).

### Toast `[.toast]`
Bottom right, 20 from the edges, 360 wide, stack max 3 (newest at bottom). `bg-raised shadow-2 radius 10`, padding 12 12 12 14. Icon 16 in tone color, title 13/500, body 12 secondary, optional actions 12/500 accent, close button 24. Auto-dismiss after 4 s (errors stay until dismissed). Mobile: full width minus 32. Fill and block toasts fire only when the tab is not on Live, to avoid duplicating the stream.

### Tabs, Tooltip, Popover
Tooltip: `bg-[--text] text-inverse`, 12/16, padding 4 8, radius 6, 300ms delay. Popover and menu: `bg-raised shadow-2 radius 10 padding 4`, items 32 high, radius 6.

### Sidebar nav `[.sidebar]`
Head 48: mark + "Hermes" + `testnet` tag (mono 10.5, bordered). Items 32 high, px 10, gap 10, radius 6, icon 16 muted, text 13/500 secondary; hover `bg-hover`; current `bg-active text-fg` with the icon in `--text`. Approvals carries a count badge (18 high, mono 11, accent-subtle) and, in the icon rail, a 6px accent dot. Group label "Account" 11/500 faint. Footer: avatar 24 (initials), email 12, wallet address 11 mono.

### TopBar `[.topbar]`
Left to right: connection pill (24 high, dot + "Perpl" + WS round trip `38 ms`; hover popover lists trading socket, market data socket, heartbeat sequence), Head (block number + age), Equity, Today PnL (signed, colored), Loss stop (72px meter + `$137 / $500`), then right-aligned Trading switch and theme toggle. Items are 12px: label muted, value mono `--text`, separated by 20px vertical hairlines. Head hides below 1280, the whole strip moves to a second row below 768.

### Skeleton `[.hm-skeleton]`
`bg-active` with a 1.6s shimmer. Skeletons reproduce the final layout exactly (KPI label 12 high, value 24 high, sub 12 high; stream rows with 6 bar stubs and a pill stub). Show only after 200 ms of loading; never on live updates.

### EmptyState `[.empty]`
Centered, padding 48 24. 40px icon tile (radius 10, raised, bordered) with a 20px icon, title 14/600, body 13/20 secondary max 380, up to two actions (primary sm + ghost sm).

### Stepper (onboarding) `[.stepper]`
Vertical, 240 wide, sticky. Each step: 24 circle (mono number; current = `--text` ring with 3px `--surface-active` halo; done = filled `--text` with a check) + title 13/500 + description 12. 1px rail between circles, solid secondary once done. Mobile: a 4-segment horizontal progress bar with titles under each segment.

### Others
- **Market tile** (risk limits): checkbox tile, padding 10 12, radius 8, sunken; checked uses `--border-strong` and raised surface with an accent checkbox; unchecked has a dashed border.
- **Save bar** (unsaved changes): sticky 16 from the bottom of the content, raised, `shadow-2`, radius 10: accent dot, summary of the change, Discard ghost, Save changes primary.
- **Countdown**: `timer` icon, "Expires in", mono 16/500 value, 120px meter underneath.
- **Grade badge**: 64x64 radius 12, letter 36/600. A positive tone, B neutral, C and D warning, F negative. A 5-step F to A scale below with the current grade outlined.

---

## 10. Screens

Copy below is final. Values are sample data; layout is what matters.

### 10.1 Landing and sign in (`landing.html`)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [H] Hermes   How it works  Report card  Safety              ☀  [Sign in] │
├──────────────────────────────────────────────────────────────────────────┤
│ (● Live on Perpl, Monad testnet)        ┌ Alert A-10482 · Breakout 15m ─┐ │
│                                         │ TradingView sends  POST /v1/… │ │
│ TradingView alerts, filled on           │ { "market":"BTC", … }         │ │
│ Perpl in under a second.                │ Hermes relays                 │ │
│                                         │ ▬▬▬ ▬▬▬ ▬▬▬ ▬▬▬ ▬▬▬ ▬▬▬(green) │ │
│ Hermes places each order inside limits  │ Received … Filled  0 … +411ms │ │
│ you set, then shows how the live fills  │ Perpl fills         0x8f3a…↗  │ │
│ compare with the chart.                 │ 112,031.0 112,048.5 1.6bps 612│ │
│ [✉ Sign in with email]  How it works →  └───────────────────────────────┘ │
│ ⚿ Trade-only keys  ⛉ Hard limits  ⚗ Testnet funds only  (stacked ghosts) │
├──────────────────────────────────────────────────────────────────────────┤
│ Set up once. Every alert after that trades itself.   [01][02][03] tiles  │
│ See if live trading matches the chart.   list  |  6 KPI tiles           │
│ Built so a bad alert cannot become a bad day.        4 safety tiles      │
│ footer                                                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

- Eyebrow: "Live on Perpl, Monad testnet"
- H1: "TradingView alerts, filled on Perpl in under a second."
- Sub: "Hermes places each order inside limits you set, then shows how the live fills compare with the chart."
- Primary: "Sign in with email" (opens the Privy modal; configure Privy `appearance: { theme: 'dark', accentColor: '#4d8eff', logo }`, login method email only, embedded wallet created on login). Secondary: "How it works".
- Proof: "Trade-only keys, no withdrawals" · "Hard limits on every order" · "Testnet funds only".
- Relay card: header "Alert A-10482 · Breakout 15m · 14:32:07.412"; sections "TradingView sends", "Hermes relays", "Perpl fills"; result labels "Alert price", "Fill price", "Slippage", "Alert to fill". The pipeline replays every few seconds (active stage sheen, 380ms per early stage, 700ms for Accepted and Filled, 2.6s pause on the result). Two faded cards sit behind it to suggest a queue.
- How it works. Title: "Set up once. Every alert after that trades itself." Intro: "No bot to write and no server to run. You keep your strategy in TradingView." Tiles: **Connect Perpl** "Sign in with email and get a wallet. Open your Perpl account and add a trade-only API key." **Set your limits** "Pick allowed markets, max position size, max leverage, a daily loss stop and a size that needs your approval." **Paste the webhook** "Copy your Hermes URL and message into a TradingView alert. Send a test alert to see it fill."
- Measure. Title: "See if live trading matches the chart." Intro: "A backtest assumes you fill at the alert price, instantly. Hermes measures what actually happened." List: "Alert price vs fill price, in basis points, for every order." "Alert to fill time, split into each step, in milliseconds." "Every alert that did not trade, with the reason." "A grade per strategy, with the formula shown."
- Safety. Title: "Built so a bad alert cannot become a bad day." **Trade-only key** "Perpl API keys can trade but can never withdraw or transfer funds." **Wallet policy** "Your wallet can only interact with the Perpl exchange contract." **Hard limits** "Every alert is checked against your limits before any order is sent." **Your approval** "Orders above your threshold wait for you, and expire if you do nothing."
- Footer: "Hermes · open source, MIT licence" and "Runs on Perpl, Monad testnet. No real funds."
- Background: a 48px hairline grid in `--border-subtle`, radially masked behind the relay card. Nothing else decorative.

### 10.2 Onboarding (`onboarding.html?step=1..4`)

```
┌ [H] Hermes testnet ────────────────── Step 2 of 4 │ email  Sign out ┐
│                                                                     │
│   ✓ Wallet            Open your Perpl account                       │
│   │ Created at sign in Perpl trades from an exchange account …       │
│   ② Perpl account     First deposit  [ 1,000.00        AUSD  Max ]   │
│   │ Approve, deposit  ┌ ✓ Approve AUSD        0x3b9e…77a1 Confirmed┐ │
│   ③ API key           │ ◌ Create account …    0xc41f…2e90 Pending  │ │
│   ④ First strategy    └──────────────────────────────────────────┘ │
│                       ⛉ This wallet can only interact with …        │
│                       ‹ Back                 [Waiting for confirmation]│
└─────────────────────────────────────────────────────────────────────┘
```
Layout: 240 stepper + 560 content column, centered, 48 top padding. Primary button `lg`, right aligned; Back is ghost, left.

**Step 1, Wallet.** Title "Your wallet is ready". Lead "Privy created this wallet when you signed in. Hermes uses it to open your Perpl account and make deposits. It needs a little MON for gas and test AUSD to deposit." Card: label "Wallet address", full address in a large mono read-only field with copy and explorer buttons, hint "Monad testnet · chain 10143"; balances "MON for gas" `0.482 MON` with "Enough for setup" (or warning "Not enough for gas yet") and "Test AUSD" `1,000.00 AUSD` with "Ready to deposit". Card "Need test funds?" / "Free, testnet only": "MON for gas · Monad faucet. Rate limited." → `faucet.monad.xyz`; "Test AUSD · Agora faucet. One request per minute, shared by everyone." Foot: "Balances refresh every block." + "Continue".

**Step 2, Perpl account.** Title "Open your Perpl account". Lead "Perpl trades from an exchange account funded with AUSD. Your wallet signs two transactions: one lets the exchange take the deposit, the other creates the account with it." Field "First deposit" with `AUSD` and `Max`; hint "Minimum set by Perpl: 10 AUSD. Wallet balance: 1,000.00 AUSD." (read the minimum from `pub/context`). Transaction rows, each: status circle, title, meta with block and tx link, status pill: "Approve AUSD" then "Create account and deposit 1,000 AUSD". Row states: Not started ("Sign in your wallet" button), Waiting for signature, Pending ("Sent, waiting for a block"), Confirmed ("Confirmed in block 41,820,114"), Failed (negative callout with the reason and "Try again"), Refused by policy (warning: "Privy refused this transaction. It was not to the Perpl exchange contract."). Policy callout: "**This wallet can only interact with the Perpl exchange contract.** Privy refuses any other transaction before it is signed, so funds cannot be sent anywhere else. Contract 0x1964…80cc". Primary reads "Waiting for confirmation" (disabled) until both confirm, then "Continue".

**Step 3, API key.** Title "Add a trade-only API key". Lead "Hermes signs in to Perpl's trading socket with this key to place your orders." Numbered card: "Open testnet.perpl.xyz/apikeys and sign once with this wallet." "Choose the **Trade** scope. Add an expiry if you want one." "Copy the key ID and the private key, then paste them below." Fields "Key ID" and "Private key" (password, reveal). Hint "Stored encrypted on the Hermes server. Never shown again after you save." Positive callout "**Trade-only keys can open and close positions. They can never withdraw or transfer funds.** Perpl enforces this, not Hermes." Result row after "Verify": "Signed in to Perpl · Account #4821 · scope trade · expires 10 Jan 2027" + pill "Verified". Errors: "Perpl rejected this key. Check that you copied both parts." / "This key has read scope only. Create one with the Trade scope." Button "Verify and continue", then "Continue".

**Step 4, First strategy.** Title "Create your first strategy". Lead "A strategy is one TradingView alert. Name it, then paste its webhook URL and message into the alert." Fields: Name (full width), Market (select with chip), "Leverage if the alert has none". Then "Webhook URL" copy field and "Message" code block ("TradingView message", meta "includes your secret", "Copy message"). After a test: positive callout "**Test alert filled in 544 ms.** Long BTC 0.001 at 112,040.5, 1.1 bps from the alert price. See every step". Foot: "Send test alert" secondary lg, "Go to Live" primary lg.

### 10.3 Live dashboard (`dashboard.html`)

```
┌sidebar┬ ● Perpl 38ms │ Head 41,822,907 0.4s │ Equity $10,482.16 │ Today −$137.20 │ Loss stop ▬▭▭ $137/$500    Trading ◉ ☀ ┐
│ Live  │ Live                                              [All strategies ▾] [➤ Send test alert] │
│ Strat │ Every TradingView alert, and what Hermes did with it.                                     │
│ Appr 2│ ┌Alerts today 47┬Fill rate 95.3%┬Median alert to fill 486ms┬Median slippage 2.1bps┐       │
│ Limits│ └───────────────┴───────────────┴──────────────────────────┴──────────────────────┘       │
│ Report│ ┌ Alert stream ● Live                       [All 47|Filled 41|Blocked 4|Missed 2] ┐        │
│       │ │ Time        Signal        Strategy     Received Verified Checked Sent Accepted Filled  Total Outcome │
│       │ │ 14:32:07.412 ↗Long BTC    Breakout 15m ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬(g)  612 ms ✓Filled  › │
│       │ │ 12s ago      0.050·$5,602 Alert 112,031.0 0ms +4ms +2ms +11ms +184ms +411ms  112,048.5·1.6bps│
│       │ │ … 10 rows                                                                       │
│       │ └ Showing 10 of 47 alerts today · times in WAT (UTC+1)                 View all ┘        │
│       │ ┌ Open positions 3   Unrealized +$19.19 ┐ ┌ Recent fills          Report card ┐          │
│       │ │ Market Side Size Notional Entry Mark uPnL Lev │ Fill  Price  Slippage  Tx   │          │
│       │ └ Margin used $3,761.65 of $10,482.16 · Perpl account #4821 ┘ └──────────────┘          │
└───────┴──────────────────────────────────────────────────────────────────────────────────────────┘
```
- Title "Live", sub "Every TradingView alert, and what Hermes did with it." Actions: strategy select "All strategies", "Send test alert" (toast: "Test alert sent" / "Breakout 15m · Long BTC 0.001. Watch it in the stream.").
- KPIs (today): "Alerts today" `47` sub "41 filled · 4 blocked · 2 missed"; "Fill rate" `95.3%` sub "41 of 43 that passed your limits"; "Median alert to fill" `486 ms` sub "p95 871 ms"; "Median slippage" `2.1 bps` sub "vs alert price · your cap is 30 bps".
- Stream card: title "Alert stream", live dot "Live", outcome filter (All, Filled, Blocked, Missed, each with a count). Columns: Time (`HH:mm:ss.SSS` + relative), Signal (side + chip; sub "size · notional"), Strategy (name; sub "Alert <price>"), the six pipeline stages, Total, Outcome (pill; sub-line per outcome, below), chevron. Row 56 min. Newest at top; new rows animate in. Row click opens the alert detail.
- Outcome sub-lines: Filled "112,048.5 · 1.6 bps" (fill price · slippage, mono); In flight "Waiting for Perpl fill"; Needs approval "1:42 left to approve"; Blocked "Over max position size" / "ZEC is not an allowed market" / "Daily loss stop reached" / "Leverage 15x is over your 10x"; Not filled "No liquidity within 30 bps"; Rejected "Perpl: insufficient margin"; Ignored "Duplicate of A-10474"; Expired "Not approved in 2:00".
- Foot: "Showing 10 of 47 alerts today · times in WAT (UTC+1)" + "View all".
- Open positions: title + count tag, meta "Unrealized +$19.19". Columns Market, Side, Size, Notional, Entry, Mark, Unrealized PnL (signed, with muted %), Lev. Foot "Margin used $3,761.65 of $10,482.16 equity" and "Perpl account #4821". Empty: "No open positions. Positions opened by your alerts show here."
- Recent fills: Fill (chip + side and size, time under), Price, Slippage, Tx (explorer link). Link "Report card".
- Mobile: stream rows become cards: signal + outcome on line 1, pipeline with ms on line 2, time · strategy · total on line 3. Positions keep Market, Side, Size, Unrealized PnL. Fills keep Fill, Price, Slippage.

### 10.4 Alert detail (`alert.html`, `alert-blocked.html`)

A full page at `/alerts/:id` (deep-linkable, shareable in support). Rows in the stream link here; Back returns to the scroll position.

```
Live › A-10482
↗ Long BTC 0.050  (✓ Filled)                     [Copy ID] [↺ Replay as test alert] [Fill on explorer]
Breakout 15m · received 14:32:07.412 WAT, 11 Oct 2026 · alert id bk15-1760189527
┌Alert price 112,031.0┬Fill price 112,048.5┬Slippage 1.6 bps┬Alert to fill 612 ms┐
┌ Lifecycle  6 of 6 stages · 612 ms ─────────────┐ ┌ Risk checks  6 passed ─┐
│ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ (labels, ms)       │ │ ✓ Strategy enabled  On  │
│ 14:32:07.412 ○ Received  POST from …   0 ms  ▏    │ │ ✓ Market allowed    BTC │
│ 14:32:07.416 ○ Verified  Secret …     +4 ms  ▏    │ │ ✓ Max position size $7,844 / $25,000 │
│ …                                               │ │ ✓ Max leverage 5.0x / 10x │
│ 14:32:08.024 ● Filled 0.050 @ …     +411 ms ▬▬▬▬ │ │ ✓ Daily loss stop $137 / $500 │
│                                    0 200 400 612 │ │ ✓ Approval threshold $5,602 / $10,000 │
└──────────────────────────────────────────────────┘ ├ Onchain  Monad testnet ─┤
┌ Perpl messages 4   Trading socket, deduplicated ─┐ │ Fill tx 0x8f3a…e21c ↗   │
│ Time  Type  Message  Block                       │ │ Fill block, Placed in block, Perpl order, rq, Account, Exchange │
└──────────────────────────────────────────────────┘ ├ Order ─────────────────┤
[ Raw payload (from TradingView) ] [ Order frame sent (mt 22) ]       │ Type, Size, Notional, Limit, Max slippage, Leverage │
```
- KPI sub-lines: "From TradingView, BINANCE:BTCUSDT 15m", "Perpl BTC, 1 fill, IOC", "Worse than alert by $0.88", "Strategy median 486 ms".
- Timeline copy: Received "POST from TradingView 52.89.214.238 to /v1/alerts/stg_8Kq2Zr"; Verified "Secret matches. Alert id is new. Message has every required field."; Risk checks passed "6 of 6 checks passed. Under the approval threshold, sent without waiting." (or "Above the approval threshold. Waited 0:21 for you."); Sent to Perpl "Order frame mt 22 · rq 1,904,233 · sn 88,412 · last block 41,822,899"; Accepted "Forwarded (mt 3), then placed in block 41,822,869 (mt 24, order 7,302,118)"; Filled "0.050 @ 112,048.5 in block 41,822,871 (mt 25) · fee $1.68". Retries appear as extra rows: "Resent with the same rq after reconnect" or "No status before last block. Resent with new rq 1,904,234."
- Perpl messages: one row per deduplicated status (`mt 3`, `mt 24`, `mt 25`, `mt 26`), each expandable to its raw JSON.
- Code blocks: "Raw payload" with the secret masked as `••••••••`; "Order frame sent" with inline comments naming enum values (`// OpenLong`, `// ImmediateOrCancel`, `// 5.00x`). Field names in the prototype frame are illustrative; render what the executor actually sent.
- Blocked variant: warning callout first: "**Blocked by your max position size.** This order would have taken your SOL position to $29,458. Your limit is $25,000 per market. Nothing was sent to Perpl. To allow orders like this, raise the limit or lower size in the TradingView message." Actions "Copy ID", "Review limit". KPIs: Alert price, Fill price "Not sent" / "No order, no fee", Order notional with "↑ $4,458 over the limit" in warning, "Time to decision 5 ms" / "Received to blocked". The failed check is listed first in Risk checks, in warning text. Onchain shows the empty state "No transaction. Blocked alerts never reach Perpl, so there is nothing onchain."
- Mobile: single column; timeline drops the time and gantt columns (time goes under the description); messages table hides Block.

### 10.5 Strategies (`strategies.html`)

```
Strategies                                                       [+ New strategy]
One strategy per TradingView alert. Each has its own webhook URL and secret.
┌ All strategies 5   4 on ┐ ┌ Breakout 15m [BTC] [stg_8Kq2Zr]    Enabled ◉ │ [➤ Send test alert] … ┐
│▌BTC Breakout 15m     ◉  │ │ Created 3 Oct 2026 · 152 alerts in the last 7 days                 │
│  ● Last alert 12s ago   │ ├ Fill rate 7d 91.2% │ Median 486ms │ Slippage 4.1bps │ Grade B Report card ┤
│  18 today · 94.4% filled│ ┌ Connect TradingView   3 fields to paste into your alert ┐
│ ETH ETH mean rev 1h  ◉  │ │ ① Webhook URL  [https://…/v1/alerts/stg_8Kq2Zr   Copy] │
│ SOL …                   │ │ ② Secret       [🔒 ••••••••hx2K  👁 ⧉] [↻ Rotate]        │
│ MON …                   │ │ ③ Message      [Strategy alert|Indicator alert] [Copy message] │
│ ZEC ZEC breakout 4h  ○  │ │                { JSON template }                       │
│  ⚠ ZEC is not in your   │ ├ ✓ Last test 14:02:11 filled in 544 ms · A-10466   ☐ Dry run: stop after risk checks ┤
│    allowed markets      │ ┌ Order settings  Applied to every alert from this strategy        Save ┐
└─────────────────────────┘ │ Order type ▾ │ Max slippage 30 bps │ Size [From alert|Fixed USD] │ Leverage 5x │
```
- List item: market chip, name (500), enable toggle (does not navigate), live dot + "Last alert 12s ago", "18 today · 94.4% filled" (plus "1 blocked" in warning when relevant). A strategy whose market is not allowed shows "ZEC is not in your allowed markets" in warning. Selected item: `bg-active` with a 2px `--text` inset bar on the left.
- Hints: Webhook "In the alert's Notifications tab, turn on Webhook URL and paste this. Webhooks need a paid TradingView plan with two-factor authentication." Secret "It goes inside the message below. Hermes ignores any alert without it. Rotating stops alerts that still use the old secret." (Rotate opens a confirm modal: "Rotate secret?" / "Alerts that still use the old secret will be ignored. Update your TradingView message right after." / "Rotate".) Message "The copied message includes your real secret. Values in {{ }} are filled in by TradingView when the alert fires. id must be unique per alert so Hermes can drop repeats."
- Template (strategy alert):
  ```json
  {
    "strategy": "stg_8Kq2Zr",
    "secret": "<real secret>",
    "id": "{{strategy.order.id}}-{{timenow}}",
    "market": "BTC",
    "action": "{{strategy.order.action}}",
    "size": "{{strategy.order.contracts}}",
    "price": "{{close}}",
    "leverage": 5,
    "time": "{{timenow}}"
  }
  ```
  The indicator-alert tab replaces `action` with a fixed `"buy"` or `"sell"` and `size` with a fixed number, and `id` with `"{{ticker}}-{{timenow}}"`.
- Send test alert posts this exact message to the webhook with a minimal size, through every check. With "Dry run" checked it stops after Checked and never reaches Perpl. Toast "Test alert sent" / "Long BTC 0.001 posted to your webhook. Watch it on Live."
- Order settings: "Order type" (Limit, immediate or cancel) hint "Fills now at the limit price or better, cancels the rest."; "Max slippage" `30 bps` hint "Limit price = alert price + 30 bps for buys, minus for sells."; "Size" From alert / Fixed USD, hint "Uses size from the message, in BTC."; "Leverage if the alert has none" `5x`, hint "Your risk limit caps this at 10x." Save is disabled until something changes.
- New strategy: a drawer with Name, Market, Leverage, then the same Connect section.
- Empty list: icon `webhook`, "No strategies yet", "Create one strategy per TradingView alert. You get a webhook URL and a message to paste.", button "New strategy".
- Mobile: list above detail, full width.

### 10.6 Risk limits (`limits.html`)

```
Risk limits                                                           [⏸ Pause trading]
Hermes checks every alert against these before anything reaches Perpl. They apply to all strategies.
┌Alerts checked today 47┬Blocked by a limit 3┬Daily loss used 27.4%┬Waiting for approval 2┐
┌ Limits   Last changed 9 Oct, 21:14 ───────────────────────────────────────────────────┐
│ Allowed markets        [BTC ☑ 112,051.3 Open $7,844] [ETH ☑] [SOL ☑] [MON ☑] [ZEC ☐ 1 alert blocked today] │
│ Max position size      [$ 25,000  per market]   Now, per market   BTC ▬▬▭▭ $7,844 / $25,000 … │
│ Max leverage           [10  x]  ──●── 1x 5x 10x 20x   Highest open position 5.0x / 10x ▬▬▭  │
│ Daily loss stop •      [$ 500  per day] Was $400.   Used today $137.20 / $500 ▬▭▭│▭ Resets in 9h 27m │
│ Approval threshold     [$ 10,000 notional] Expire after [2 min ▾]   Last 7 days 8 asked … │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌ ⛉ Wallet policy   Enforced by Privy on every transaction your wallet signs ┐
│ ✓ Only the Perpl exchange contract   0x1964…80cc ↗ │ ✓ AUSD approvals to the exchange only │ ✓ Deposit cap 1,000 AUSD │ ⟲ Last refusal … │
└──────────────────────────────────────────────────────────────────────────┘
╭ • 1 unsaved change · Daily loss stop $400 to $500          Discard  [Save changes] ╮ (sticky)
```
Each limit is a row of three columns: label and explanation (300) | control (280) | live usage (rest).

| Limit | Explanation copy | Usage copy |
|---|---|---|
| Allowed markets | "Alerts for any other market are blocked. Turning a market off does not close open positions." | Tiles show mark price and "Open $7,844" / "No position" / "1 alert blocked today" |
| Max position size | "Largest position Hermes may hold in one market, in USD notional, after the order fills." | "Now, per market" with one meter per open market, "Largest 31.4%"; hint "2 alerts blocked by this today." |
| Max leverage | "Alerts asking for more are blocked, not reduced. Perpl's own market maximum still applies." | "Highest open position 5.0x / 10x", "BTC and ETH at 5.0x, MON at 3.0x." |
| Daily loss stop | "Once today's realized and unrealized loss reaches this, Hermes blocks new orders until 00:00 UTC. Orders that close a position still go through." | "Used today $137.20 / $500", tick at 80%, "Resets in 9h 27m. You get a warning at 80%." |
| Approval threshold | "Orders above this notional wait for you in Approvals. If you do nothing, they expire and are not sent." | "Last 7 days 8 asked": "2 waiting now · 5 approved · 1 expired · 0 rejected", link "Review the 2 waiting" |

- Changing a value marks the label with an accent dot, the hint reads "Was $400. Saved changes apply to the next alert.", and the sticky save bar appears. Save toast: "Limits saved" / "They apply from the next alert."
- Validation: position size > 0; leverage 1 to 20 ("Leverage must be between 1x and 20x."); loss stop > 0; threshold > 0; at least one market ("Keep at least one market, or pause trading instead.").
- Pause trading opens the modal "Pause trading?" / "Hermes stops sending new orders from every strategy. Alerts still arrive and are logged as blocked. Open positions stay open." / "Cancel" "Pause trading". While paused, a warning banner shows on every page: "Trading is paused. Alerts are logged and blocked." with "Resume".
- Wallet policy (read only): "Only the Perpl exchange contract" / "Any transaction to another address is refused before signing."; "AUSD approvals to the exchange only" / "Token approvals to any other spender are refused."; "Deposit cap" / "Per transaction." `1,000 AUSD`; "Last refusal" / "9 Oct, 18:02 · transfer to 0x52a1…0f3e refused by policy" `1 in 7 days`.

### 10.7 Approvals (`approvals.html`)

```
Approvals (2)                                                     ⚙ Change threshold
Orders above your $10,000 approval threshold wait here. Nothing is sent until you approve.
┌ ↘ Short BTC 0.120                                          ⏱ Expires in 1:42 ┐
│ Breakout 15m · alert A-10479 at 14:18:02                      ▬▬▬▬▬▬▬▬▭     │
├ Notional $13,445.28 │ Alert price 112,044.0 │ Mark now 112,051.3 │ Limit price 111,707.9 │ Leverage 5.0x ┤
├ ✓ Passed the other 5 checks. Approving asks Privy to confirm it is you.   [Reject R] [✓ Approve and send A] ┤
└──────────────────────────────────────────────────────────────────────────────┘
┌ Decided   Last 7 days ┐  Asked │ Order │ Strategy │ Notional │ Decision │ Result
```
- Stat sub-lines: "$3,445 over threshold", "from TradingView", price move since the alert ("0.7 bps better for a short" in positive, or "10.1 bps worse than alert" in warning), "alert minus 30 bps", "max 10x".
- Countdown: accent meter, switches to warning text and meter under 60 s. At 0 the card collapses into the Decided table as Expired with toast "Expired" / "Short BTC 0.120 was not sent."
- Approve: Privy confirmation, then toast "Approved and sent" / "Short BTC 0.120 is on its way to Perpl." The alert's pipeline continues from Sent. Reject: toast "Rejected" / "Short BTC 0.120 was not sent." Keyboard: A approves and R rejects the top card.
- Decided table: decision pill (Approved with "in 0:21", Expired with "after 2:00", Rejected) and Result ("Filled · 1.9 bps", "Not sent").
- Empty: icon `inbox`, "Nothing to approve", "Orders above $10,000 wait here for you. You can change that amount in Risk limits."
- The sidebar badge and a toast ("Approval needed" / "Short BTC 0.120 · $13,445 · expires in 2:00" / "Review") announce new requests on any page.

### 10.8 Report card (`report.html`)

```
Report card                                       [BTC Breakout 15m ▾] [24h|7d|30d|All]
How a strategy performs live, measured against the alerts that drove it.
┌ Grade  4 to 11 Oct · 148 eligible alerts ┐ ┌Fill rate 91.2%┬Median 486ms┬p95 871ms┐
│ [B]  88.7 / 100                           │ ├Median slip 4.1bps┬Realized PnL +$1,284.50┬Stopped 22┤
│ An A starts at 90. The biggest drag is …  │ ┌ Alert to fill latency  Every 6 hours   ▬ Median ▬ p95 ┐
│ F D C [B] A                               │ │ line chart, one ms axis, 1.42 s · Perpl reconnect    │
│ Part     Weight Measured   Score          │ └──────────────────────────────────────────────────────┘
│ Fill rate 40%   91.2%      91.2           │
│ Slippage  35%   4.1 bps    88.3           │
│ Speed     25%   p95 871 ms 85.2           │
│ ▾ How the grade is computed               │
└───────────────────────────────────────────┘
┌ Slippage distribution  135 fills · bps worse than the alert price ┐ ┌ Blocked and missed  22 alerts … ┐
│ histogram <0 … 12+, median line                                    │ │ Reason  Kind  Alerts  Share  Last │
│ Better than alert 6 │ Within 5 bps 80 │ Over 10 bps 9              │ └ Blocked and ignored alerts do not count against the grade. ┘
```
- KPI copy: "Fill rate" `91.2%` "135 of 148 eligible alerts"; "Median alert to fill" `486 ms` "↓ 38 ms faster than prior 7d"; "p95 alert to fill" `871 ms` "Slowest 1.42 s"; "Median slippage" `4.1 bps` "p95 9.8 bps · cap 30 bps"; "Realized PnL" `+$1,284.50` "Slippage cost −$71.40 · fees −$42.18"; "Stopped" `22` "9 blocked by limits · 13 missed".
- **Grade, exactly as shown to the user** ("How the grade is computed"): "Score = 40% fill rate + 35% slippage score + 25% speed score. Fill rate only counts alerts that passed your limits, so a block you asked for never lowers the grade. Slippage score is 100 at a median of 2 bps or less and 0 at 20 bps. Speed score is 100 when p95 alert to fill is 500 ms or less and 0 at 3 s. A is 90 and up, B 80, C 70, D 60, F below 60. Needs 20 eligible alerts."
  - `fillScore = filled / eligible × 100` where eligible = passed every check (duplicates and blocks excluded; missed, rejected, expired approvals included).
  - `slipScore = clamp(100 − (medianBps − 2) / 18 × 100, 0, 100)`
  - `speedScore = clamp(100 − (p95Ms − 500) / 2500 × 100, 0, 100)`
  - `score = 0.40 fillScore + 0.35 slipScore + 0.25 speedScore`, 1 decimal.
  - Under 20 eligible alerts: grade tile shows "Not enough data" and "Grades start after 20 alerts that pass your limits. 12 so far."
  - The one-line explanation names the weakest part: "The biggest drag is 13 alerts that passed your limits but did not fill." / "…median slippage of 9.2 bps." / "…p95 time of 2.1 s."
- Charts (follow the dataviz rules: one y axis, hairline solid grid, 2px lines, bars at most 24px wide with 3px rounded tops, text in text tokens, no dual axes):
  - Latency: median (accent, 2px, 10% wash) and p95 (`--chart-2`, 1.5px) per 6-hour bucket, y axis 0 to 1.5 s, legend in the card head, one annotation on the worst point. Crosshair tooltip: "4 Oct, 06:00 · Median 498 ms · p95 842 ms".
  - Slippage histogram: 1 bps bins from "<0" (better than alert) to "12+", one hue, median line with label "median 4.1". Per-bar tooltip "19 fills · 3 to 4 bps worse". Summary strip underneath.
  - Render charts at the container's pixel width (no SVG scaling) so 11px labels stay 11px; thin tick labels on narrow screens.
- Blocked and missed table, grouped by reason, sorted by count: reason, kind pill (outline: Missed negative, Blocked warning, Ignored neutral), count, share meter, last seen. Row click filters the Live stream to those alerts.

### 10.9 States (`states.html`)
Every component state lives here: button variants and sizes, inputs (default, focus, error, read only, select, disabled), toggles, checkbox, segmented, tabs, meters at each tone, every status pill, every pipeline terminal state, loading skeletons, empty states, toasts, modal, error callouts, and the reconnecting top bar plus banner ("**Perpl trading socket dropped.** Reconnecting, attempt 2 of 5. New alerts wait up to 10 s, then fail with a reason.").

Other empty, loading and error copy:
- Live, no alerts: "No alerts yet" / "When TradingView sends an alert to your webhook, it shows up here within a second. Send a test alert to try it now." / "Send test alert" "Copy webhook URL".
- Load failure: "Could not load alerts" / "Hermes did not respond. Alerts are still being processed on the server." / "Retry".
- Save failure toast: "Could not save limits" / "The server did not answer. Your changes are still here." / "Try again".
- Key rejected: "**Perpl rejected the API key.** It may have expired or been revoked. Create a new trade-only key and paste it again."
- Loss stop reached banner: "**Daily loss stop reached.** New orders are blocked until 00:00 UTC. Closing orders still go through."
- Offline (WebSocket to Hermes lost): top bar pill "Offline", banner negative "Live updates stopped. Reconnecting." Data stays on screen, dimmed to 60%.

---

## 11. Responsive rules

- No horizontal page scroll at 390px (verified for every prototype page). Tables hide secondary columns on mobile instead.
- Sidebar: full (>= 1280), icon rail with tooltips and an accent dot for approvals (768 to 1279), off-canvas drawer (< 768).
- Top bar on mobile: row 1 menu, mark, connection pill, Trading switch, theme; row 2 a 3-column strip: Equity, Today, Loss stop (value over meter).
- Grids collapse at 1100 (12-column spans become full width). KPI strips go 4 → 2 and 3 → 2 columns.
- Touch targets: buttons stay 32+ high; icon buttons in dense rows are 28 but sit in a 40+ row.
- Approval cards on mobile: countdown becomes a full-width row, stats in 2 columns, buttons split the width.

---

## 12. Microcopy rules

- **No em-dashes or en-dashes in UI copy.** Use a period, a comma, "to" for ranges ("4 to 11 Oct"), or a middle dot `·` to join metadata. Missing values are `n/a`.
- Plain verbs, second person, present tense: "Hermes blocks new orders", "Orders above this wait for you".
- No hype words: never "seamless", "powerful", "lightning", "revolutionary", "AI", "supercharge", "unlock".
- Buttons say what happens: "Approve and send", "Send test alert", "Save changes", "Pause trading", "Rotate". Not "Submit", "OK", "Confirm".
- Errors say what happened and what to do next, in that order.
- Say "blocked" only for Hermes limits, "missed" for alerts that passed checks but did not fill, "ignored" for duplicates, "rejected" for Perpl refusals, "expired" for approvals that ran out.
- Numbers in copy follow section 8 (`$500`, `30 bps`, `2 min`).
- Glossary: alert (from TradingView), order (sent to Perpl), fill (executed), strategy (one alert setup), limit (risk rule), threshold (approval size), stage (pipeline step), alert price (`price` in the message), fill price (from `mt 25`).

---

## 13. Implementation notes

1. **Import order**: `@import "tailwindcss"; @import "./styles/tokens.css"; @import "./styles/components.css";` in `src/index.css`. `tokens.css` resets Tailwind's palette, so utilities like `bg-gray-800` or `text-red-500` do not exist. That is deliberate.
2. **Set `data-theme` before React mounts** (inline script in `index.html` reading `localStorage` in try/catch) to avoid a flash. Default dark.
3. **`[hidden]` must win**: keep a global `[hidden] { display: none !important; }` (Tailwind preflight has it; any custom `display` class can otherwise override it).
4. **Pipeline state comes from the server.** Map executor events to stages: webhook accepted → Received; secret, schema and dedupe pass → Verified; all limits pass → Checked; frame written to the socket → Sent; `mt 24` placed (not `mt 3`, which only means forwarded) → Accepted; `mt 25` → Filled. Deltas are server timestamps; never compute them from client receive times.
5. **Deduplicate Perpl status messages** before rendering the timeline (the same `mt 24` can arrive twice after a reconnect).
6. **Live updates**: update rows in place keyed by alert id; do not re-sort a row once rendered; animate only the new row and changed values.
7. **Numbers**: one formatter module (section 8). Use U+2212 for minus and U+2026 for truncation. Use `Intl.NumberFormat('en-US')` for grouping regardless of locale so columns stay consistent.
8. **Copy buttons** copy full values (full hash, full secret, full message with the real secret) even when the display is truncated or masked.
9. **Charts**: hand-rolled SVG as in `report.html` is fine. Measure the container with a ResizeObserver and render at its pixel width. One y axis per chart.
10. **Focus**: every interactive element shows `--focus-ring` on `:focus-visible`. Rows that navigate are links (`<a>`), not clickable `<div>`s.
11. **Reduced motion** is handled in `components.css`; do not add JS animations that bypass it.
12. **Privy modal**: set `appearance.theme` to match `data-theme`, accent `#4d8eff` (dark) or `#2563eb` (light), and pass the Hermes mark as the logo so the hand-off looks native.
