/**
 * Monad testnet chain helpers (viem). NO private keys are handled here: every builder returns an unsigned
 * `{to, data, value}` request. The web app signs them with the user's Privy wallet; the server may send them through
 * Privy's server wallet API. Read helpers use a viem public client.
 *
 * Account setup order (perpl.md section 3), wait for each receipt before the next:
 *   1. faucet: Agora `requestFunds(wallet)` for test AUSD (1 call / 60 s, shared) and MON from faucet.monad.xyz for gas
 *   2. AUSD.approve(Exchange, amount)
 *   3. Exchange.createAccount(amount)          (amount >= min_account_open_amount, 100 AUSD on testnet)
 *   4. Exchange.allowOrderForwarding(true)     (REQUIRED for API trading, otherwise every order fails with sr 34)
 *   5. enrol / paste the API key
 */
import { createPublicClient, defineChain, encodeFunctionData, getAddress, http, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { agoraFaucetAbi } from "./abi/faucet";
import { erc20Abi } from "./abi/erc20";
import { exchangeAbi } from "./abi/exchange";

export const MONAD_TESTNET_CHAIN_ID = 10143;
export const MONAD_TESTNET_RPC = "https://testnet-rpc.monad.xyz";

export const monadTestnet: Chain = defineChain({
  id: MONAD_TESTNET_CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [MONAD_TESTNET_RPC] } },
  blockExplorers: { default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" } },
  testnet: true,
});

/** Addresses from docs/research/perpl.md section 1. The collateral token MUST be re-read from pub/context at runtime. */
export const PERPL_TESTNET = {
  chainId: MONAD_TESTNET_CHAIN_ID,
  /** Exchange contract (instance id 12). */
  exchange: "0x1964c32f0be608e7d29302aff5e61268e72080cc" as Address,
  /** Test AUSD, 6 decimals. */
  collateral: "0xa9012a055bd4e0edff8ce09f960291c09d5322dc" as Address,
  collateralDecimals: 6,
  /** Agora AUSD faucet: `requestFunds(address to)`, 1 call per 60 s, shared by everyone. */
  faucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C" as Address,
  instanceId: 12,
  /** Testnet minimum to open an account: 100 AUSD (re-read `min_account_open_amount`). */
  minAccountOpenCns: 100_000_000n,
  /** Testnet minimum top-up: 10 AUSD (`min_deposit_amount`). */
  minDepositCns: 10_000_000n,
} as const;

/** An unsigned transaction request, ready for Privy `sendTransaction` / viem `walletClient.sendTransaction`. */
export interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
  /** Human label for UIs and logs. */
  label?: string;
}

export interface ChainAddresses {
  exchange: Address;
  collateral: Address;
  faucet?: Address;
}

const defaults: ChainAddresses = { exchange: PERPL_TESTNET.exchange, collateral: PERPL_TESTNET.collateral, faucet: PERPL_TESTNET.faucet };

function pos(amount: bigint, what: string): bigint {
  if (amount <= 0n) throw new RangeError(`${what} must be > 0`);
  return amount;
}

/** `AUSD.approve(Exchange, amountCNS)`. */
export function buildApproveTx(amountCns: bigint, a: Partial<ChainAddresses> = {}): TxRequest {
  const c = { ...defaults, ...a };
  return { to: getAddress(c.collateral), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(c.exchange), pos(amountCns, "amount")] }), value: 0n, label: "Approve AUSD for Perpl" };
}

/** `Exchange.createAccount(amountCNS)`: opens the exchange account with an initial deposit (needs a prior approve). */
export function buildCreateAccountTx(amountCns: bigint, a: Partial<ChainAddresses> = {}): TxRequest {
  const c = { ...defaults, ...a };
  return { to: getAddress(c.exchange), data: encodeFunctionData({ abi: exchangeAbi, functionName: "createAccount", args: [pos(amountCns, "amount")] }), value: 0n, label: "Create Perpl account" };
}

/** `Exchange.allowOrderForwarding(true)`: required before any API order is accepted. */
export function buildAllowOrderForwardingTx(allow = true, a: Partial<ChainAddresses> = {}): TxRequest {
  const c = { ...defaults, ...a };
  return { to: getAddress(c.exchange), data: encodeFunctionData({ abi: exchangeAbi, functionName: "allowOrderForwarding", args: [allow] }), value: 0n, label: allow ? "Enable order forwarding" : "Disable order forwarding" };
}

/** `Exchange.depositCollateral(amountCNS)`: top up the account (needs a prior approve; min 10 AUSD on testnet). */
export function buildDepositTx(amountCns: bigint, a: Partial<ChainAddresses> = {}): TxRequest {
  const c = { ...defaults, ...a };
  return { to: getAddress(c.exchange), data: encodeFunctionData({ abi: exchangeAbi, functionName: "depositCollateral", args: [pos(amountCns, "amount")] }), value: 0n, label: "Deposit collateral" };
}

/** `Exchange.increasePositionCollateral(perpId, amountCNS)` (the same thing as API order type 6). */
export function buildIncreasePositionCollateralTx(perpetualId: bigint | number, amountCns: bigint, a: Partial<ChainAddresses> = {}): TxRequest {
  const c = { ...defaults, ...a };
  return {
    to: getAddress(c.exchange),
    data: encodeFunctionData({ abi: exchangeAbi, functionName: "increasePositionCollateral", args: [BigInt(perpetualId), pos(amountCns, "amount")] }),
    value: 0n,
    label: "Add position collateral",
  };
}

/** Agora faucet `requestFunds(to)`: test AUSD, 1 call per 60 s globally. */
export function buildFaucetRequestTx(to: Address, a: Partial<ChainAddresses> = {}): TxRequest {
  const c = { ...defaults, ...a };
  if (!c.faucet) throw new Error("no faucet address configured");
  return { to: getAddress(c.faucet), data: encodeFunctionData({ abi: agoraFaucetAbi, functionName: "requestFunds", args: [getAddress(to)] }), value: 0n, label: "Request test AUSD" };
}

export interface SetupInput {
  /** Collateral to deposit when opening the account (CNS). Must be >= min_account_open_amount. */
  amountCns: bigint;
  hasAccount: boolean;
  /** Current AUSD allowance to the Exchange (CNS). */
  allowanceCns: bigint;
  /** Order forwarding already enabled? (Read `fw` from the wallet snapshot; there is no on-chain getter.) Default false. */
  forwardingEnabled?: boolean;
  minAccountOpenCns?: bigint;
}

/** The ordered transactions still needed to get a wallet from nothing to "can place API orders". */
export function buildSetupPlan(input: SetupInput, a: Partial<ChainAddresses> = {}): TxRequest[] {
  const min = input.minAccountOpenCns ?? PERPL_TESTNET.minAccountOpenCns;
  const steps: TxRequest[] = [];
  if (!input.hasAccount) {
    if (input.amountCns < min) throw new RangeError(`initial deposit ${input.amountCns} is below the minimum to open an account (${min})`);
    if (input.allowanceCns < input.amountCns) steps.push(buildApproveTx(input.amountCns, a));
    steps.push(buildCreateAccountTx(input.amountCns, a));
  }
  if (!input.forwardingEnabled) steps.push(buildAllowOrderForwardingTx(true, a));
  return steps;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------------

export interface OnchainAccount {
  accountId: bigint;
  balanceCns: bigint;
  lockedBalanceCns: bigint;
  /** 0 = not frozen. */
  frozen: number;
  accountAddr: Address;
}

export interface PerplChainOptions {
  rpcUrl?: string;
  /** Inject a viem client (tests). */
  publicClient?: PublicClient<Transport, Chain>;
  addresses?: Partial<ChainAddresses>;
}

export class PerplChain {
  readonly client: PublicClient<Transport, Chain>;
  readonly addresses: ChainAddresses;

  constructor(opts: PerplChainOptions = {}) {
    this.client = opts.publicClient ?? (createPublicClient({ chain: monadTestnet, transport: http(opts.rpcUrl ?? MONAD_TESTNET_RPC) }) as PublicClient<Transport, Chain>);
    this.addresses = { ...defaults, ...opts.addresses };
  }

  /** Exchange account of a wallet, or null when none exists (the contract reverts with AccountDoesNotExist). */
  async getAccountByAddress(owner: Address): Promise<OnchainAccount | null> {
    try {
      const info = await this.client.readContract({ address: getAddress(this.addresses.exchange), abi: exchangeAbi, functionName: "getAccountByAddr", args: [getAddress(owner)] });
      if (info.accountId === 0n) return null;
      return { accountId: info.accountId, balanceCns: info.balanceCNS, lockedBalanceCns: info.lockedBalanceCNS, frozen: Number(info.frozen), accountAddr: info.accountAddr };
    } catch (e) {
      const text = `${(e as { name?: string }).name ?? ""} ${(e as Error).message ?? ""} ${(e as { shortMessage?: string }).shortMessage ?? ""}`;
      if (/AccountDoesNotExist|reverted|execution reverted/i.test(text)) return null;
      throw e;
    }
  }

  /** Test AUSD balance in CNS. */
  async getAusdBalance(owner: Address): Promise<bigint> {
    return this.client.readContract({ address: getAddress(this.addresses.collateral), abi: erc20Abi, functionName: "balanceOf", args: [getAddress(owner)] });
  }

  /** AUSD allowance granted to the Exchange, in CNS. */
  async getAusdAllowance(owner: Address, spender: Address = this.addresses.exchange): Promise<bigint> {
    return this.client.readContract({ address: getAddress(this.addresses.collateral), abi: erc20Abi, functionName: "allowance", args: [getAddress(owner), getAddress(spender)] });
  }

  async getMinAccountOpenCns(): Promise<bigint> {
    return this.client.readContract({ address: getAddress(this.addresses.exchange), abi: exchangeAbi, functionName: "getMinAccountOpenCNS" });
  }

  /** Native MON balance (gas). */
  async getGasBalance(owner: Address): Promise<bigint> {
    return this.client.getBalance({ address: getAddress(owner) });
  }

  async getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  /** Everything the UI needs to decide which setup transactions are still required. */
  async getSetupStatus(owner: Address, amountCns: bigint = PERPL_TESTNET.minAccountOpenCns): Promise<{ account: OnchainAccount | null; ausdBalance: bigint; allowance: bigint; plan: TxRequest[] }> {
    const [account, ausdBalance, allowance] = await Promise.all([this.getAccountByAddress(owner), this.getAusdBalance(owner), this.getAusdAllowance(owner)]);
    // `fw` has no on-chain getter: callers pass forwardingEnabled from the wallet snapshot. Plan assumes "not enabled yet".
    const plan = buildSetupPlan({ amountCns, hasAccount: account !== null, allowanceCns: allowance }, this.addresses);
    return { account, ausdBalance, allowance, plan };
  }

  async waitForReceipt(hash: Hex, timeoutMs = 60_000): Promise<{ status: "success" | "reverted"; blockNumber: bigint }> {
    const r = await this.client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
    return { status: r.status, blockNumber: r.blockNumber };
  }
}
