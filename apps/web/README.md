# @hermes/web

React 18 + Vite + TypeScript + Tailwind v4 front end. This README is for the engineers building screens on top of the foundation.
Spec: `design/DESIGN.md` (binding) and `design/prototype/` (pixel source of truth). Open **`/components`** in the running app to see every primitive in every state next to `design/prototype/states.html`.

```bash
pnpm --filter @hermes/web dev        # :5173, proxies /api and /hooks to :8787
pnpm --filter @hermes/web typecheck
pnpm --filter @hermes/web test       # vitest + testing-library
pnpm --filter @hermes/web build
```

Run the server in DEV auth mode with demo data (no Privy needed):

```bash
pnpm --filter @hermes/server seed:demo
AUTH_MODE=dev pnpm --filter @hermes/server dev
```

## Auth modes

`VITE_PRIVY_APP_ID` set at build time means Privy (email login, embedded wallet, Monad testnet). Empty means DEV mode: click "Sign in" on the landing page and the app unlocks; the server (AUTH_MODE=dev) treats every request as the demo user. The Privy SDK is a separate chunk and is not loaded in DEV mode.

```tsx
const { ready, authenticated, user, login, logout, mode } = useAuth();   // user: { email, walletAddress } | null
const { address, ready, sendTransaction } = useEmbeddedWallet();
const addSigner = useAddHermesSigner();      // react-query mutation: addSigner.mutateAsync()
```

`sendTransaction(tx)` is Privy's `useSendTransaction` (user confirms in the Privy dialog). In DEV mode there is no browser wallet, so it calls `POST /api/wallet/actions`; pass `devAction` so the server knows what to run:

```ts
await sendTransaction({ to, data, chainId: 10143, description: "Approve AUSD", devAction: { kind: "approve_collateral" } });
```

## Data: `src/lib/queries.ts`

Typed hooks for every endpoint, keys in `qk`. Types come from `@hermes/shared`. Queries are disabled until signed in. Mutations invalidate what they touch.

| Area | Hooks |
|---|---|
| Session | `useMe`, `useRegisterWallet` |
| Limits | `useLimits`, `useUpdateLimits`, `useSetPaused` |
| Strategies | `useStrategies`, `useStrategy(id)`, `useCreateStrategy`, `useUpdateStrategy(id)`, `useToggleStrategy`, `useDeleteStrategy`, `useRevealSecret`, `useRotateSecret`, `useSendTestAlert` |
| Alerts | `useAlerts({ strategyId, status, limit })`, `useAlertsInfinite`, `useAlert(id)` |
| Trading | `useOrders`, `useFills`, `usePositions`, `useAccount` |
| Approvals | `useApprovals(status?)`, `usePendingApprovalCount`, `useApprove`, `useReject` |
| Perpl | `usePerplConnection`, `usePutPerplConnection`, `useDeletePerplConnection` |
| Reports | `useReport(strategyId, "7d" \| "30d" \| "all")` |
| Wallet | `useSignerConfig`, `usePrivyWallet`, `useSignerRegistered`, `useWalletActions`, `useRunWalletAction`, `usePolicyDemo` |

Errors are `ApiError` (`status`, `code`, `message`); use `errorMessage(e)` for toasts. `useRevealSecret` is a mutation on purpose: the plaintext secret never enters the query cache.

## Live updates: `src/lib/stream.ts`

The shell opens the SSE stream once (ticket, reconnect with backoff). Each event patches or invalidates the caches above, so **never poll**: render from the hooks and rows update in place (existing alert rows are replaced, never re-sorted; new ones are prepended).

```tsx
const { state } = useStreamStatus();            // idle | connecting | live | reconnecting | offline
useStreamEvents((e) => { if (e.type === "alert") flash(e.alert.id); });   // raw events, e.g. for row-in animation
```

## Formatting: `src/lib/format.ts`

Never format inline. `formatPrice(v, market)`, `formatSize`, `formatUsd(v, { summary })`, `formatSignedUsd` (U+2212), `formatPercent`, `formatFraction`, `formatBps`, `slippageTone`, `formatMs`, `formatDeltaMs`, `formatLeverage(lv)`, `formatClock` (`14:32:18.904`), `formatTableTime`, `formatRelativeTime`, `formatCountdown`, `formatTimeZone`, `shortHex` (`0x1234…abcd`), `explorerTxUrl`, `explorerAddressUrl`, `maskSecret`, `orNA(value, fmt)` (renders `n/a`). Unknown is always `n/a`, never `-` or `0`.

## Alert lifecycle: `src/lib/alert-view.ts`

```tsx
const { stages, totalMs } = alertPipeline(alert);        // six stages from server event timestamps
const outcome = alertOutcome(alert);                      // { kind, label, why, mono } for StatusPill + sub-line
<LifecyclePipeline stages={stages} />                     // row form for the stream
<LifecyclePipeline stages={stages} size="lg" />           // with stage names, for alert detail
<StatusPill kind={outcome.kind} />
<SideLabel side={alertSide(alert)} />
```

## Styling

- `src/styles/tokens.css` and `components.css` are the designer's. `src/styles/app.css` is `design/prototype/prototype.css` ported 1:1 into `@layer components`, so primitives reproduce the prototype exactly. Component classes (`.btn`, `.card`, `.kpi`, `table.t`, `.stream-row`, `.tl-row`, `.set-row`, `.appr-*`, `.lp-*`, `.ob-*`) match the prototype markup; copy structure from the prototype HTML.
- Tailwind utilities (`mt-4 w-full flex gap-3`) always win over component classes. Use token colors only: `bg-surface`, `text-muted`, `border-line`, `text-positive-text`. There is no default palette.
- Page layout: `grid grid-cols-12 gap-4` with `col-span-7`, or the prototype's `.grid-12` + `.span-7` (collapses at 1100).
- `hide-sm` on a cell hides it below 768. Mobile rules are in `app.css`; keep prototype class names to inherit them.

## Primitives: `src/components/ui` (import from `components/ui`)

```tsx
import { Button, Card, CardHeader, KpiRow, KpiTile, DataTable, StatusPill, LifecyclePipeline, useToast } from "../components/ui";
```

| Component | Notes |
|---|---|
| `Button`, `IconButton`, `ButtonLink`, `ButtonAnchor` | `variant` primary/secondary/ghost/danger/accent, `size` sm/md/lg, `icon`, `loading` + `loadingLabel="Saving"`, `kbd="A"`. `IconButton` needs `label` and adds a tooltip |
| `Input`, `Textarea`, `NumberInput`, `Select`, `Field` | `label`, `hint`, `error`; `Input` has `prefix`/`suffix`/`icon`/`trailing`/`mono`/`size="lg"`; `NumberInput` has `unit`, grouping, `min`/`max`; `Select` is a popover list with `market` chips, `variant="button"` for "All strategies" |
| `Toggle` (`tone="positive"` for Trading), `Checkbox`, `SegmentedControl`, `Tabs` | `SegmentedControl` options take `count` |
| `Badge`/`Tag`, `MarketChip`, `SideLabel`, `StatusPill`, `ConnectionPill` | Pills for every outcome via `kind` |
| `Card`, `CardHeader`, `CardBody`, `CardFooter` | `CardHeader title meta actions` |
| `KpiRow cols={3\|4\|6}`, `KpiTile`, `KpiDelta` | `value`, `unit`, `sub`, `mono`, `tone`, `loading` |
| `DataTable` | `columns` (`numeric`, `hideSm`, `mono`, `width`), `rowHref`/`onRowClick`, `density`, `stickyHeader`+`maxHeight`, `loading`, `empty` |
| `LifecyclePipeline`, `PipelineDots`, `PipelineStageNames` | Fill animation when a stage flips from `active` to done |
| `Timeline`, `Meter` (`threshold`, auto tone), `Countdown` | |
| `CodeBlock` (JSON highlight, `copyValue`), `CopyField` (`secret`, `loadValue`, `href`) | Copy always copies the full real value |
| `Drawer`, `Modal`, `ConfirmModal`, `ToastProvider` + `useToast()`, `Tooltip`, `Popover` | Focus trap, Escape, scroll lock. `toast.positive(title, body, { actions })`; errors stay until dismissed |
| `Skeleton`, `SkeletonRows`, `useDelayedFlag`, `EmptyState`, `Callout`, `Banner`, `Spinner`, `Stepper` | Show skeletons only after 200 ms |
| `Sparkline`, `LineChart`, `Histogram`, `ChartLegend` | SVG at container pixel width (ResizeObserver) |
| `KeyValue`, `ChecksList`, `ExplorerLink`, `SectionNum`, `ListItem`, `MarketTile`, `SaveBar`, `GradeBadge`, `GradeScale`, `Avatar`, `Kbd`, `Divider` | |

Shell (`components/shell`): `PageHeader` (use on every page: `<PageHeader title subtitle actions crumbs />`, sets `document.title`), `AppShell`, `Sidebar`, `TopBar`, `Mark`. Page titles and subtitles are in `lib/routes.ts` (`PAGE.live` and so on).

## Routes

`/` landing (public) · `/onboarding` (own frame, no sidebar) · `/live` · `/alerts/:id` (route; a Live drawer can embed the same content) · `/strategies` · `/strategies/:id` · `/limits` · `/approvals` · `/report/:strategyId?` · `/wallet` · `/components` (public). Everything except `/`, `/components` is behind `RequireAuth`: signed out goes to `/`; with Privy and no Perpl connection it redirects to `/onboarding`; in DEV mode a "Finish setup" banner shows instead. Replace the `<Placeholder>` in `App.tsx` with your page; keep the `<PageHeader>`.

## Rules of thumb

- Rows that navigate are links (`rowHref`, `<Link>`), not clickable divs. Icon-only buttons need a label.
- Color means state: use `StatusPill`, `SideLabel`, `formatSignedUsd` + `pnlTone` so every color also has a sign, word or icon.
- Copy: no em or en dashes, sentence case, `n/a` for missing (DESIGN.md section 12).
- Test files live next to the code (`*.test.ts(x)`); `src/test/setup.ts` provides jest-dom and a ResizeObserver stub.
