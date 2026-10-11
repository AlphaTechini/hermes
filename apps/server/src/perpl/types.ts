import type { AccountSummary, Position } from "@hermes/shared";

/** Perpl trading-WS order type codes (`mt: 22`, field `t`). */
export const PerplOrderType = {
  OpenLong: 1,
  OpenShort: 2,
  CloseLong: 3,
  CloseShort: 4,
  Cancel: 5,
  IncreasePositionCollateral: 6,
  Change: 7,
} as const;
export type PerplOrderTypeCode = (typeof PerplOrderType)[keyof typeof PerplOrderType];

/** Order flags: 0 GTC, 1 PostOnly, 2 FillOrKill, 4 ImmediateOrCancel. */
export type PerplOrderFlags = 0 | 1 | 2 | 4;

/** Frame-level parameters of a place-order request. The client owns `sn`, and `rq` when not given. */
export interface PlaceOrderParams {
  marketId: number;
  type: PerplOrderTypeCode;
  /** Base-unit size as a decimal number (client scales by market decimals). */
  size: number;
  /** Limit price; omit for market orders (IOC with `maxSlippageBps`). */
  price?: number;
  /** Leverage as a plain multiple, e.g. 3 (client sends hundredths). */
  leverage?: number;
  flags?: PerplOrderFlags;
  /** Max slippage in bps (`ms`). */
  maxSlippageBps?: number;
  /** Idempotency key. Strictly increasing per account. Pass the SAME rq to retry a frame with no status yet. */
  rq?: number;
  /** Last execution block (`lb`); omit to let the client pick head + a safe offset. */
  lastExecutionBlock?: number;
}

export interface PlaceOrderResult {
  sn: number;
  rq: number;
  lb?: number;
}

export interface CancelParams {
  marketId: number;
  /** Perpl order id to cancel. */
  orderId: string;
  rq?: number;
}

/** Messages pushed by the client. Mirrors the Perpl `mt` frames after decoding. */
export type PerplEvent =
  | { kind: "connection"; state: "connected" | "disconnected" | "reconnecting" }
  /** mt 24: authoritative order status. `cid` echoes our `sn`. */
  | {
      kind: "order";
      sn?: number;
      rq?: number;
      orderId?: string;
      status: "accepted" | "partially_filled" | "filled" | "cancelled" | "rejected" | "expired";
      errorCode?: string;
      message?: string;
      atMs: number;
    }
  /** mt 25: a fill. */
  | {
      kind: "fill";
      sn?: number;
      rq?: number;
      orderId?: string;
      fillId?: string;
      price: number;
      size: number;
      fee: number;
      realizedPnl?: number;
      txHash?: string;
      block?: number;
      atMs: number;
    }
  /** mt 26/27: position snapshot or change. */
  | { kind: "positions"; positions: Position[] }
  /** mt 21: account update. */
  | { kind: "account"; account: AccountSummary };

export type PerplEventListener = (event: PerplEvent) => void;

/**
 * Everything the server needs from Perpl. One instance per user connection (own API key / account).
 * Implemented twice: live (WS + REST) and simulator, behind this same interface.
 */
export interface PerplClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  /** Subscribe to pushed events. Returns an unsubscribe function. */
  onStatus(cb: PerplEventListener): () => void;
  getAccount(): Promise<AccountSummary>;
  getPositions(): Promise<Position[]>;
  getMarkPrice(marketId: number): Promise<number>;
  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult>;
  cancel(params: CancelParams): Promise<PlaceOrderResult>;
  /** Current chain head block (for `lb`). */
  headBlock(): Promise<number>;
}

/**
 * How the server finds the PerplClient for a user. The live/sim engineer provides the implementation
 * and passes it to `buildApp({ perpl })`. `refresh` is called after the user's stored connection
 * (account id + API key) was created, replaced or deleted.
 */
export interface PerplClientProvider {
  get(userId: string): PerplClient | undefined;
  refresh?(userId: string): Promise<void>;
}
