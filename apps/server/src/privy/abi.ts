import { MONAD_TESTNET_CHAIN_ID, type WalletActionKind } from "@hermes/shared";
import { encodeFunctionData, formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem";

/**
 * Minimal ABI fragments copied from docs/research/abi/{ERC20,PerplExchange,AgoraFaucet}.min.json.
 * Only the functions Hermes' Privy signer is allowed to call. `as const` so viem infers the arg types.
 */
export const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const exchangeAbi = [
  {
    type: "function",
    name: "createAccount",
    stateMutability: "nonpayable",
    inputs: [{ name: "amountCNS", type: "uint256" }],
    outputs: [{ name: "accountId", type: "uint256" }],
  },
  {
    type: "function",
    name: "depositCollateral",
    stateMutability: "nonpayable",
    inputs: [{ name: "amountCNS", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "allowOrderForwarding",
    stateMutability: "nonpayable",
    inputs: [{ name: "allow", type: "bool" }],
    outputs: [],
  },
] as const;

export const faucetAbi = [
  {
    type: "function",
    name: "requestFunds",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }],
    outputs: [],
  },
] as const;

export const AUSD_DECIMALS = 6;

/** A transaction the Hermes server asks Privy to sign and broadcast from the user's wallet. */
export interface TxRequest {
  chainId: number;
  to: Address;
  data: Hex;
  /** Native value in wei. */
  value: bigint;
}

export interface BuiltTx extends TxRequest {
  description: string;
}

export interface TxBuildContext {
  exchange: string;
  ausd: string;
  faucet: string;
  /** The user's embedded wallet (faucet recipient). */
  walletAddress: string;
  /** Default amount for approve_collateral, AUSD base units. */
  approveCapBase: bigint;
}

export class AmountRequiredError extends Error {
  constructor(kind: string) {
    super(`"amount" (AUSD) is required for ${kind}`);
    this.name = "AmountRequiredError";
  }
}

const fmt = (base: bigint) => `${formatUnits(base, AUSD_DECIMALS)} AUSD`;

/** Calldata builders for the five Hermes wallet actions. `amount` is AUSD in human units ("100"). */
export function buildWalletTx(
  kind: Exclude<WalletActionKind, "policy_demo">,
  ctx: TxBuildContext,
  amount?: string,
): BuiltTx {
  const exchange = getAddress(ctx.exchange);
  const ausd = getAddress(ctx.ausd);
  const faucet = getAddress(ctx.faucet);
  const base = (): bigint => {
    if (amount === undefined) throw new AmountRequiredError(kind);
    return parseUnits(amount, AUSD_DECIMALS);
  };
  const common = { chainId: MONAD_TESTNET_CHAIN_ID, value: 0n };

  switch (kind) {
    case "approve_collateral": {
      const amt = amount === undefined ? ctx.approveCapBase : parseUnits(amount, AUSD_DECIMALS);
      return {
        ...common,
        to: ausd,
        data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [exchange, amt] }),
        description: `Approve ${fmt(amt)} to the Perpl Exchange`,
      };
    }
    case "create_account": {
      const amt = base();
      return {
        ...common,
        to: exchange,
        data: encodeFunctionData({ abi: exchangeAbi, functionName: "createAccount", args: [amt] }),
        description: `Create the Perpl account with ${fmt(amt)}`,
      };
    }
    case "allow_forwarding":
      return {
        ...common,
        to: exchange,
        data: encodeFunctionData({ abi: exchangeAbi, functionName: "allowOrderForwarding", args: [true] }),
        description: "Allow Perpl order forwarding (lets the trade-only API key place orders)",
      };
    case "deposit": {
      const amt = base();
      return {
        ...common,
        to: exchange,
        data: encodeFunctionData({ abi: exchangeAbi, functionName: "depositCollateral", args: [amt] }),
        description: `Deposit ${fmt(amt)} collateral into Perpl`,
      };
    }
    case "faucet":
      return {
        ...common,
        to: faucet,
        data: encodeFunctionData({ abi: faucetAbi, functionName: "requestFunds", args: [getAddress(ctx.walletAddress)] }),
        description: "Request test AUSD from the Agora faucet",
      };
  }
}

/** Deliberately forbidden transactions for the policy demo. */
export const DEMO_BURN_ADDRESS: Address = "0x000000000000000000000000000000000000dEaD";

export function buildPolicyDemoTx(ctx: Pick<TxBuildContext, "ausd">, variant: "native_transfer" | "approve_other_spender"): BuiltTx {
  if (variant === "approve_other_spender") {
    const amt = parseUnits("1", AUSD_DECIMALS);
    return {
      chainId: MONAD_TESTNET_CHAIN_ID,
      to: getAddress(ctx.ausd),
      value: 0n,
      data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [DEMO_BURN_ADDRESS, amt] }),
      description: `Policy demo: approve 1 AUSD to an arbitrary spender ${DEMO_BURN_ADDRESS} (must be denied)`,
    };
  }
  return {
    chainId: MONAD_TESTNET_CHAIN_ID,
    to: DEMO_BURN_ADDRESS,
    value: parseUnits("0.001", 18),
    data: "0x",
    description: `Policy demo: send 0.001 MON to an arbitrary address ${DEMO_BURN_ADDRESS} (must be denied)`,
  };
}
