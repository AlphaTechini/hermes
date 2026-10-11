/** Append-only list of migrations. Never edit a shipped migration; add a new one. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  privy_did TEXT NOT NULL UNIQUE,
  email TEXT,
  wallet_address TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE perpl_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  api_key_public TEXT NOT NULL,
  api_key_private_enc TEXT NOT NULL,
  collateral REAL,
  created_at INTEGER NOT NULL,
  last_rq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  default_market TEXT,
  default_size_usd REAL,
  default_leverage REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_strategies_user ON strategies(user_id);

CREATE TABLE risk_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json TEXT NOT NULL
);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT,
  raw_body TEXT NOT NULL,
  parsed_json TEXT,
  status TEXT NOT NULL,
  block_reason TEXT,
  error_code TEXT,
  market TEXT,
  side TEXT,
  kind TEXT,
  size_usd REAL,
  alert_price REAL,
  received_at_ms REAL NOT NULL,
  created_at INTEGER NOT NULL
);
-- Duplicates are stored with a NULL key, so the unique index only guards the first alert per key.
CREATE UNIQUE INDEX uq_alerts_strategy_key ON alerts(strategy_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_alerts_user_received ON alerts(user_id, received_at_ms DESC);
CREATE INDEX idx_alerts_strategy_received ON alerts(strategy_id, received_at_ms DESC);

CREATE TABLE alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  at_ms REAL NOT NULL,
  detail_json TEXT
);
CREATE INDEX idx_alert_events_alert ON alert_events(alert_id, at_ms);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  alert_id TEXT REFERENCES alerts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rq INTEGER,
  sn INTEGER,
  market_id INTEGER NOT NULL,
  side TEXT NOT NULL,
  kind TEXT NOT NULL,
  type TEXT NOT NULL,
  size REAL,
  price REAL,
  leverage REAL,
  lb INTEGER,
  perpl_order_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  tx_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_alert ON orders(alert_id);

CREATE TABLE fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  alert_id TEXT REFERENCES alerts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id TEXT,
  price REAL NOT NULL,
  size REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  realized_pnl REAL,
  tx_hash TEXT,
  block INTEGER,
  at_ms REAL NOT NULL
);
CREATE UNIQUE INDEX uq_fills_external ON fills(order_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_fills_user_at ON fills(user_id, at_ms DESC);
CREATE INDEX idx_fills_alert ON fills(alert_id);

CREATE TABLE positions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  size REAL NOT NULL,
  entry_price REAL NOT NULL,
  mark_price REAL NOT NULL,
  upnl REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, market)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL UNIQUE REFERENCES alerts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX idx_approvals_user_status ON approvals(user_id, status);

CREATE TABLE daily_pnl (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  realized_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`,
  },
  {
    version: 2,
    name: "privy_wallets_and_wallet_actions",
    sql: `
-- The user's Privy embedded wallet and whether the Hermes server signer (key quorum + policy) was added to it.
CREATE TABLE privy_wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wallet_id TEXT NOT NULL,
  address TEXT NOT NULL,
  signer_added_at INTEGER,
  policy_id TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Every transaction the Hermes server signer sent (or tried to send) from a user's wallet.
CREATE TABLE wallet_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  to_address TEXT NOT NULL,
  data TEXT NOT NULL,
  value TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  error TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_wallet_actions_user_created ON wallet_actions(user_id, created_at DESC);
`,
  },
  {
    version: 3,
    name: "strategy_extras_limits_updated_at_order_frames",
    sql: `
-- Strategy extras: dry run (stop after the risk checks), per-strategy max slippage override, reserved order type.
ALTER TABLE strategies ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0;
ALTER TABLE strategies ADD COLUMN max_slippage_bps INTEGER;
ALTER TABLE strategies ADD COLUMN order_type TEXT NOT NULL DEFAULT 'market';

-- When the limits were last saved.
ALTER TABLE risk_limits ADD COLUMN updated_at INTEGER;

-- Raw Perpl frames per order: the mt:22 frame sent and every mt:3 / mt:24 / mt:25 frame received for it.
CREATE TABLE order_frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  mt INTEGER NOT NULL,
  at_ms REAL NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX idx_order_frames_order ON order_frames(order_id, at_ms, id);
`,
  },
];
