import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { TOKENS } from "../config";
import { getPrices, Price } from "../prices";
import { Actions, createActions } from "./actions";
import { agentMode, guardrails } from "./env";
import { appendLog, readLog } from "./log";
import { runRules } from "./rules";

const MODEL = "claude-opus-5-5";

const DEFAULT_MANDATE = `Preserve capital first. Target roughly 50% USDC / 50% SOL by USD value,
with at most 10% in any other allowlisted token. Rebalance only when an asset drifts more than
10 percentage points from target. Do nothing if prices look stale or confidence intervals are wide.`;

const symbols = TOKENS.map((t) => t.symbol) as [string, ...string[]];

/** Run one decision cycle. Called by /api/agent/tick (cron) or the "Run now" button. */
export async function runAgentTick() {
  const mode = agentMode();
  try {
    const prices = await getPrices();
    const actions = createActions(prices);
    const tag = `[${mode}${actions.dryRun ? ", dry run" : ""}] `;

    if (mode === "rules") {
      const summary = await runRules(actions);
      return appendLog({ kind: "tick", summary: tag + summary, details: { mode, dryRun: actions.dryRun } });
    }

    const { summary, details } = await runClaude(actions, prices);
    return appendLog({ kind: "tick", summary: tag + summary, details: { mode, dryRun: actions.dryRun, ...details } });
  } catch (err) {
    const message = err instanceof Anthropic.APIError ? `Claude API ${err.status}: ${err.message}` : String(err);
    return appendLog({ kind: "error", summary: `[${mode}] ${message}` });
  }
}

async function runClaude(actions: Actions, prices: Record<string, Price>) {
  const client = new Anthropic();

  const swapInput = z.object({
    input_symbol: z.enum(symbols),
    output_symbol: z.enum(symbols),
    amount: z.number().describe("Amount of the input token, in whole units (e.g. 1.5 SOL)"),
    reason: z.string().describe("One or two sentences: why this trade, tied to the mandate"),
  });

  const tools = [
    betaZodTool({
      name: "get_portfolio",
      description:
        "Current vault holdings with USD values and portfolio weights, plus open Squads proposals awaiting human approval.",
      inputSchema: z.object({}),
      run: async () => JSON.stringify(await actions.portfolio()),
    }),
    betaZodTool({
      name: "get_quote",
      description: "Get a Jupiter quote for a swap without executing it. Use before any trade.",
      inputSchema: swapInput.omit({ reason: true }),
      run: async (input) => JSON.stringify(await actions.quote(input)),
    }),
    betaZodTool({
      name: "execute_small_swap",
      description: `Execute a swap immediately via the agent's on-chain spending limit. Only for trades worth at most $${guardrails.autoTradeMaxUsd} with SOL or USDC as input. Larger trades must use propose_swap.`,
      inputSchema: swapInput,
      run: async (input) => JSON.stringify(await actions.smallSwap(input)),
    }),
    betaZodTool({
      name: "propose_swap",
      description: `Create a Squads proposal for a swap that a human must approve in the dashboard. Use for trades above $${guardrails.autoTradeMaxUsd}, up to $${guardrails.proposalMaxUsd}. Do not propose a trade that duplicates an open proposal.`,
      inputSchema: swapInput,
      run: async (input) => JSON.stringify(await actions.propose(input)),
    }),
  ];

  const recent = (await readLog(10))
    .map((e) => `- ${e.at} [${e.kind}] ${e.summary}${e.reasoning ? ` — ${e.reasoning}` : ""}`)
    .join("\n");

  const system = `You manage a small on-chain treasury held in a Squads multisig vault on Solana.

Mandate (set by the owners):
${process.env.AGENT_MANDATE ?? DEFAULT_MANDATE}

How you act:
- Start with get_portfolio. Quote with get_quote before any trade.
- Trades up to $${guardrails.autoTradeMaxUsd} with SOL or USDC as input: execute_small_swap.
- Larger trades: propose_swap. A human approves those; don't re-propose something already open.
- At most ${guardrails.maxActionsPerTick} trades this run. Doing nothing is a fine outcome.
- If a tool returns an error, adapt or stop; don't retry the same call blindly.${
    actions.dryRun ? "\n- Dry-run mode is on: trades are logged, not sent. Decide exactly as you would for real." : ""
  }

Finish with a short plain-text summary (3–5 sentences) of what you saw, what you did, and why.
This summary is shown to the owners in the dashboard.`;

  const userMessage = `Time: ${new Date().toISOString()}
Prices (USD, source: ${Object.values(prices)[0]?.source ?? "none"}): ${formatPrices(prices)}

Recent agent activity (newest first):
${recent || "(none yet)"}

Run your check now.`;

  const final = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    // On a safety refusal, the API retries on a fallback model automatically.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    max_iterations: 12,
    system,
    tools,
    messages: [{ role: "user", content: userMessage }],
  });

  const summary =
    final.stop_reason === "refusal"
      ? `Model declined this run (${final.stop_details?.category ?? "unknown"}).`
      : final.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim() || "(no summary)";

  return { summary, details: { stopReason: final.stop_reason, actionsTaken: actions.actionsTaken, usage: final.usage } };
}

function formatPrices(prices: Record<string, Price>) {
  return Object.values(prices)
    .map(
      (p) =>
        `${p.symbol}=$${p.usd.toPrecision(6)} (±${p.confidence.toPrecision(2)}, ${Math.round(Date.now() / 1000 - p.publishTime)}s old)`,
    )
    .join(", ");
}
