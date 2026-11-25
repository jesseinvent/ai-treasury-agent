import "server-only";
import { TokenInfo, tokenBySymbol } from "../config";
import { Price } from "../prices";
import { guardrails, isDryRun, spendingLimits } from "./env";
import { getQuote, Quote } from "./jupiter";
import { appendLog } from "./log";
import { getHoldings, vaultPda } from "./solana";
import { autoSwap, listProposals, proposeSwap } from "./squads";

export type SwapRequest = {
  input_symbol: string;
  output_symbol: string;
  /** Whole units of the input token. */
  amount: number;
  reason: string;
};

const toRaw = (amount: number, decimals: number) => BigInt(Math.floor(amount * 10 ** decimals));

/**
 * The only path to moving funds, shared by the Claude agent and the rules
 * rebalancer. Applies every code guardrail and honours dry-run mode.
 */
export function createActions(prices: Record<string, Price>) {
  const dryRun = isDryRun();
  let actionsTaken = 0;

  const usdValue = (symbol: string, amount: number) => amount * (prices[symbol]?.usd ?? 0);

  function check(req: Omit<SwapRequest, "reason">) {
    const from = tokenBySymbol(req.input_symbol);
    const to = tokenBySymbol(req.output_symbol);
    if (!from || !to) throw new Error("Token not on the allowlist.");
    if (from.mint === to.mint) throw new Error("Input and output must differ.");
    if (!(req.amount > 0)) throw new Error("Amount must be positive.");
    if (actionsTaken >= guardrails.maxActionsPerTick)
      throw new Error(`Max ${guardrails.maxActionsPerTick} actions per tick reached. Stop and summarize.`);
    const usd = usdValue(from.symbol, req.amount);
    if (!usd) throw new Error(`No price for ${from.symbol}.`);
    return { from, to, usd };
  }

  function describeQuote(quote: Quote, from: TokenInfo, to: TokenInfo, amount: number) {
    return {
      in: `${amount} ${from.symbol}`,
      inUsd: usdValue(from.symbol, amount),
      expectedOut: Number(quote.outAmount) / 10 ** to.decimals,
      minOut: Number(quote.otherAmountThreshold) / 10 ** to.decimals,
      priceImpactPct: quote.priceImpactPct,
      route: quote.routePlan.map((r) => r.swapInfo.label).filter(Boolean),
    };
  }

  return {
    dryRun,
    usdValue,
    get actionsTaken() {
      return actionsTaken;
    },

    async portfolio() {
      const holdings = await getHoldings(vaultPda());
      const rows = holdings.map((h) => ({ ...h, usd: usdValue(h.symbol, h.amount) }));
      const totalUsd = rows.reduce((s, r) => s + r.usd, 0);
      const openProposals = (await listProposals(5)).filter(
        (p) => p.status === "Active" || p.status === "Approved",
      );
      return {
        totalUsd,
        holdings: rows.map((r) => ({
          symbol: r.symbol,
          amount: r.amount,
          usd: Number(r.usd.toFixed(2)),
          weightPct: totalUsd ? Number(((r.usd / totalUsd) * 100).toFixed(2)) : 0,
        })),
        openProposals,
      };
    },

    async quote(req: Omit<SwapRequest, "reason">) {
      const from = tokenBySymbol(req.input_symbol);
      const to = tokenBySymbol(req.output_symbol);
      if (!from || !to) throw new Error("Token not on the allowlist.");
      const quote = await getQuote({
        inputMint: from.mint,
        outputMint: to.mint,
        amountRaw: toRaw(req.amount, from.decimals),
        slippageBps: guardrails.maxSlippageBps,
      });
      return describeQuote(quote, from, to, req.amount);
    },

    /** Trade via the agent's spending limit, no human approval. */
    async smallSwap(req: SwapRequest) {
      const { from, to, usd } = check(req);
      if (usd > guardrails.autoTradeMaxUsd)
        throw new Error(`$${usd.toFixed(2)} exceeds the $${guardrails.autoTradeMaxUsd} auto-trade cap. Use propose_swap.`);
      if (!spendingLimits()[from.mint])
        throw new Error(`No spending limit for ${from.symbol}; only SOL/USDC can be auto-traded. Propose instead.`);
      actionsTaken++;

      const label = `${req.amount} ${from.symbol} → ${to.symbol} (~$${usd.toFixed(2)})`;
      if (dryRun) {
        const quote = await this.quote(req);
        await appendLog({
          kind: "dry_run",
          summary: `[dry run] Would auto-swap ${label}, expecting ~${quote.expectedOut.toPrecision(6)} ${to.symbol}`,
          reasoning: req.reason,
          details: { quote },
        });
        return { ok: true, dryRun: true, quote };
      }

      const result = await autoSwap({
        inputMint: from.mint,
        outputMint: to.mint,
        amountRaw: toRaw(req.amount, from.decimals),
        decimals: from.decimals,
        slippageBps: guardrails.maxSlippageBps,
      });
      const { pullSig, swapSig, returnSig, receivedRaw } = result;
      const rest = { pullSig, swapSig, returnSig, receivedRaw };
      await appendLog({
        kind: "auto_swap",
        summary: `Swapped ${label}`,
        reasoning: req.reason,
        txSignature: result.swapSig,
        details: rest,
      });
      return { ok: true, ...rest };
    },

    /** Open a Squads proposal that a human approves in the dashboard. */
    async propose(req: SwapRequest) {
      const { from, to, usd } = check(req);
      if (usd > guardrails.proposalMaxUsd)
        throw new Error(`$${usd.toFixed(2)} exceeds the $${guardrails.proposalMaxUsd} proposal cap.`);
      actionsTaken++;

      const label = `${req.amount} ${from.symbol} → ${to.symbol} (~$${usd.toFixed(2)})`;
      if (dryRun) {
        const quote = await this.quote(req);
        await appendLog({
          kind: "dry_run",
          summary: `[dry run] Would propose ${label}, expecting ~${quote.expectedOut.toPrecision(6)} ${to.symbol}`,
          reasoning: req.reason,
          details: { quote },
        });
        return { ok: true, dryRun: true, quote };
      }

      const result = await proposeSwap({
        inputMint: from.mint,
        outputMint: to.mint,
        amountRaw: toRaw(req.amount, from.decimals),
        slippageBps: guardrails.maxSlippageBps,
        memo: `AI agent: ${req.amount} ${from.symbol} -> ${to.symbol}`,
      });
      await appendLog({
        kind: "proposal",
        summary: `Proposed ${label}`,
        reasoning: req.reason,
        txSignature: result.signature,
        transactionIndex: result.transactionIndex.toString(),
      });
      return { ok: true, transactionIndex: result.transactionIndex.toString(), note: "Awaiting human approval." };
    },
  };
}

export type Actions = ReturnType<typeof createActions>;
