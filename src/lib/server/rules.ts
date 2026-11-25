import "server-only";
import { Actions } from "./actions";
import { guardrails, rulesConfig, spendingLimits } from "./env";
import { tokenBySymbol } from "../config";

/**
 * A coded rebalancer, used when AGENT_MODE=rules (or there is no Anthropic key).
 * When an asset is more than `driftPct` points off target, it moves value from
 * the most overweight asset into the most underweight one, using the same
 * guarded actions (and dry-run mode) as the Claude agent.
 */
export async function runRules(actions: Actions): Promise<string> {
  const cfg = rulesConfig();
  const p = await actions.portfolio();

  if (p.totalUsd < cfg.minTradeUsd) return `Vault holds $${p.totalUsd.toFixed(2)}; nothing to manage yet.`;

  const drifts = Object.entries(cfg.targets).map(([symbol, target]) => {
    const h = p.holdings.find((x) => x.symbol === symbol);
    const weight = h?.weightPct ?? 0;
    return { symbol, target, weight, drift: weight - target, amount: h?.amount ?? 0 };
  });
  const state = drifts.map((d) => `${d.symbol} ${d.weight.toFixed(1)}% (target ${d.target}%)`).join(", ");

  const over = drifts.reduce((a, b) => (b.drift > a.drift ? b : a));
  const under = drifts.reduce((a, b) => (b.drift < a.drift ? b : a));
  if (Math.max(over.drift, -under.drift) <= cfg.driftPct)
    return `Within ±${cfg.driftPct}pp of target: ${state}. No action.`;

  if (p.openProposals.length > 0)
    return `Drift detected (${state}), but proposal #${p.openProposals[0].transactionIndex} is still open. Waiting for it.`;

  // Move the smaller of the two gaps, so neither side overshoots its target.
  let tradeUsd = (Math.min(over.drift, -under.drift) / 100) * p.totalUsd;
  const overPrice = over.amount ? p.holdings.find((h) => h.symbol === over.symbol)!.usd / over.amount : 0;
  if (!overPrice) return `No price for ${over.symbol}; skipping.`;

  let amount = tradeUsd / overPrice;
  if (over.symbol === "SOL") {
    amount = Math.min(amount, Math.max(0, over.amount - cfg.solReserve));
    tradeUsd = amount * overPrice;
  }
  if (tradeUsd < cfg.minTradeUsd) return `Drift detected (${state}), but the trade would be under $${cfg.minTradeUsd}.`;

  // Large gaps are rebalanced in steps of at most proposalMaxUsd.
  if (tradeUsd > guardrails.proposalMaxUsd) {
    amount *= guardrails.proposalMaxUsd / tradeUsd;
    tradeUsd = guardrails.proposalMaxUsd;
  }
  amount = Number(amount.toPrecision(6));

  const req = {
    input_symbol: over.symbol,
    output_symbol: under.symbol,
    amount,
    reason: `Rules: ${state}. Moving ~$${tradeUsd.toFixed(2)} from ${over.symbol} to ${under.symbol}.`,
  };
  const canAuto =
    tradeUsd <= guardrails.autoTradeMaxUsd && !!spendingLimits()[tokenBySymbol(over.symbol)?.mint ?? ""];

  if (canAuto) {
    await actions.smallSwap(req);
    return `${req.reason} ${actions.dryRun ? "Dry run: logged the auto-swap only." : "Auto-swapped via the spending limit."}`;
  }
  await actions.propose(req);
  return `${req.reason} ${actions.dryRun ? "Dry run: logged the proposal only." : "Opened a proposal for your approval."}`;
}
