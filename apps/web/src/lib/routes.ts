import { Activity, ChartColumn, Hand, KeyRound, Layers, Shield, Webhook, type LucideIcon } from "lucide-react";

export interface NavEntry {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  /** Shows the pending approvals count. */
  count?: "approvals";
}

export const NAV_MAIN: NavEntry[] = [
  { id: "live", label: "Live", to: "/live", icon: Activity },
  { id: "strategies", label: "Strategies", to: "/strategies", icon: Webhook },
  { id: "approvals", label: "Approvals", to: "/approvals", icon: Hand, count: "approvals" },
  { id: "limits", label: "Risk limits", to: "/limits", icon: Shield },
  { id: "report", label: "Report card", to: "/report", icon: ChartColumn },
];
export const NAV_ACCOUNT: NavEntry[] = [
  { id: "wallet", label: "Wallet and keys", to: "/wallet", icon: KeyRound },
  { id: "components", label: "Components", to: "/components", icon: Layers },
];

/** Page titles and subtitles (DESIGN.md section 10). Use with <PageHeader {...PAGE.live} />. */
export const PAGE = {
  live: { title: "Live", subtitle: "Every TradingView alert, and what Hermes did with it." },
  strategies: { title: "Strategies", subtitle: "One strategy per TradingView alert. Each has its own webhook URL and secret." },
  limits: { title: "Risk limits", subtitle: "Hermes checks every alert against these before anything reaches Perpl. They apply to all strategies." },
  approvals: { title: "Approvals", subtitle: "Orders above your approval threshold wait here. Nothing is sent until you approve." },
  report: { title: "Report card", subtitle: "How a strategy performs live, measured against the alerts that drove it." },
  wallet: { title: "Wallet and keys", subtitle: "Your Privy wallet, the policy that guards it, and your Perpl API key." },
  components: { title: "Components and states", subtitle: "Reference for implementers. Every state on this page has a matching spec in DESIGN.md section 9." },
  alert: { title: "Alert", subtitle: "Every stage of this alert, with timings." },
  strategy: { title: "Strategy", subtitle: "Webhook, secret and order settings for one TradingView alert." },
} as const;

export const ONBOARDING_STEPS = [
  { title: "Wallet", description: "Created at sign in" },
  { title: "Perpl account", description: "Approve and deposit" },
  { title: "API key", description: "Trade only" },
  { title: "First strategy", description: "Webhook for TradingView" },
] as const;
