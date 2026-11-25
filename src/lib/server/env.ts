import "server-only";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env.example)`);
  return value;
}

/** The agent's hot key. It is a Squads member with Initiate-only permission. */
export function agentKeypair(): Keypair {
  const raw = required("AGENT_SECRET_KEY").trim();
  // Accept either a base58 secret or a JSON byte array (solana-keygen format).
  const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  return Keypair.fromSecretKey(bytes);
}

export const guardrails = {
  /** Trades up to this USD value go through the agent's spending limit, no human needed. */
  autoTradeMaxUsd: Number(process.env.AGENT_AUTO_TRADE_MAX_USD ?? "25"),
  /** Hard ceiling per proposal, even with human approval. */
  proposalMaxUsd: Number(process.env.AGENT_PROPOSAL_MAX_USD ?? "1000"),
  maxSlippageBps: Number(process.env.AGENT_MAX_SLIPPAGE_BPS ?? "100"),
  /** Max swaps (auto + proposed) the agent may make in one tick. */
  maxActionsPerTick: Number(process.env.AGENT_MAX_ACTIONS_PER_TICK ?? "2"),
};

/** Spending-limit PDAs created by `npm run setup:vault`, keyed by mint. */
export function spendingLimits(): Record<string, PublicKey> {
  const out: Record<string, PublicKey> = {};
  const sol = process.env.SPENDING_LIMIT_SOL;
  const usdc = process.env.SPENDING_LIMIT_USDC;
  if (sol) out["So11111111111111111111111111111111111111112"] = new PublicKey(sol);
  if (usdc) out["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"] = new PublicKey(usdc);
  return out;
}

/**
 * Who makes decisions:
 *  - "claude": the LLM agent (needs ANTHROPIC_API_KEY)
 *  - "rules":  a coded rebalancer, no LLM and no API cost
 * Defaults to "claude" when an Anthropic key is set, otherwise "rules".
 */
export function agentMode(): "claude" | "rules" {
  const mode = process.env.AGENT_MODE;
  if (mode === "claude" || mode === "rules") return mode;
  return process.env.ANTHROPIC_API_KEY ? "claude" : "rules";
}

/**
 * Dry run: decisions are made and Jupiter quotes are fetched, but no transaction
 * is sent. ON unless AGENT_DRY_RUN=false.
 */
export const isDryRun = () => process.env.AGENT_DRY_RUN !== "false";

/** Settings for the "rules" rebalancer. */
export function rulesConfig() {
  // e.g. "USDC:50,SOL:50" (percent by USD value; must sum to 100)
  const targets: Record<string, number> = {};
  for (const part of (process.env.AGENT_TARGET ?? "USDC:50,SOL:50").split(",")) {
    const [symbol, pct] = part.split(":").map((s) => s.trim());
    if (symbol && pct) targets[symbol.toUpperCase()] = Number(pct);
  }
  const sum = Object.values(targets).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.01) throw new Error(`AGENT_TARGET must sum to 100 (got ${sum}).`);
  return {
    targets,
    /** Rebalance when any target asset is off by more than this many percentage points. */
    driftPct: Number(process.env.AGENT_DRIFT_PCT ?? "10"),
    /** Never sell SOL below this; the vault needs it for rent and fees. */
    solReserve: Number(process.env.AGENT_SOL_RESERVE ?? "0.05"),
    /** Ignore trades smaller than this. */
    minTradeUsd: Number(process.env.AGENT_MIN_TRADE_USD ?? "2"),
  };
}

export const JUPITER_API =process.env.JUPITER_API_URL ?? "https://lite-api.jup.ag/swap/v1";
export const CRON_SECRET = process.env.CRON_SECRET ?? "";
