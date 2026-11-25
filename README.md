# AI Treasury Agent

A Claude-run Solana treasury. The funds sit in a **Squads v4 vault**. An LLM agent
checks the portfolio on a schedule and trades through **Jupiter**. Humans approve
anything large from a **Next.js + Wallet Adapter** dashboard.

```
Browser (Wallet Adapter)              Next.js server
 • deposit SOL/USDC to vault           /api/agent/tick  (cron or "Run now")
 • approve / reject / execute            Claude (tool runner) ──► get_portfolio
 • read the agent's reasoning                                  ├─► get_quote (Jupiter)
                                                               ├─► execute_small_swap
                                                               └─► propose_swap
                                       /api/vault  (balances, proposals, log)
```

## Integrated components

In short: **Pyth** says what things are worth, **Jupiter** makes the trade, **Squads** decides who can move the money, and **Claude** decides what to do.

### Squads v4: multisig vault
A Solana multisig program. Funds sit in a vault owned by the program, not by any single
key, and move only when the multisig's rules are met.
- **Used for:** holding the treasury and enforcing who can move it.
- **Setup:** you have all permissions (Initiate, Vote, Execute); the agent has *Initiate* only.
  Threshold 1, so a single human approval is enough.
- **Spending limits** let the agent move up to 50 USDC and 0.25 SOL per day (configurable),
  and only to its own wallet, with no vote.
- **Code:** [`src/lib/server/squads.ts`](src/lib/server/squads.ts),
  [`scripts/setup-vault.ts`](scripts/setup-vault.ts) · SDK: `@sqds/multisig`
- **Docs:** https://docs.squads.so

### Jupiter: swap aggregator
Routes each trade across Solana DEXs (Raydium, Orca, Meteora, …) to get the best price,
splitting it across pools or routing it through other tokens when that pays more.
- **Used for:** quotes (`get_quote`), small swaps from the agent's wallet (`/swap`), and swap
  instructions with the vault as the user for Squads proposals (`/swap-instructions`).
- **Fallback price source** when no Pyth key is set (`/price/v3`).
- **Code:** [`src/lib/server/jupiter.ts`](src/lib/server/jupiter.ts) · API: `JUPITER_API_URL`
  (keyless `lite-api.jup.ag` by default)
- **Note:** mainnet only. Quotes use `maxAccounts=24` so routes fit in a vault transaction.
- **Docs:** https://dev.jup.ag

### Pyth: price oracle
First-party prices from 100+ exchanges and trading firms, combined into one price
per asset, each with a **confidence interval** and a **publish time**.
- **Used for:** USD values, portfolio weights, and the dollar checks on trades (auto-trade
  cap, proposal cap). The agent sees each price's confidence and age, and its prompt tells it
  to stand down on stale or uncertain prices.
- **Pull model:** prices come from Hermes (Pyth's price API) on demand.
- **Auth:** since the Aug 2026 Pyth Core upgrade, Hermes requires `PYTH_API_KEY` (sent as a
  Bearer token). Without it the app uses Jupiter prices.
- **Code:** [`src/lib/prices.ts`](src/lib/prices.ts); feed IDs are in [`src/lib/config.ts`](src/lib/config.ts)
- **Docs:** https://docs.pyth.network

### Claude (Anthropic API): the agent
Makes the decisions in each run, calling tools until it's done, then writes a summary for the dashboard.
- **Model:** `claude-opus-5-5` with adaptive thinking and effort `medium`. Server-side refusal
  fallback is on (`fallbacks: "default"`).
- **Loop:** Anthropic SDK tool runner (`client.beta.messages.toolRunner`) with Zod-typed tools:
  `get_portfolio`, `get_quote`, `execute_small_swap`, `propose_swap`. At most 12 iterations per run.
- **Code:** [`src/lib/server/agent.ts`](src/lib/server/agent.ts) · Env: `ANTHROPIC_API_KEY`, `AGENT_MANDATE`
- **Docs:** https://platform.claude.com/docs

### Solana Wallet Adapter: human signing
Connects Phantom, Backpack, Solflare and other wallets in the browser (detected
automatically via Wallet Standard). All human actions are signed here; the server never
holds your key.
- **Used for:** deposits, and approving, rejecting and executing Squads proposals.
- **Code:** [`src/components/WalletProviders.tsx`](src/components/WalletProviders.tsx),
  [`src/components/Dashboard.tsx`](src/components/Dashboard.tsx)

### Solana RPC + web3.js / SPL Token
Reads balances and accounts, and sends and confirms transactions.
- **Used for:** vault and agent balances, proposal status, and v0 transactions with address lookup tables.
- **Config:** `NEXT_PUBLIC_RPC_URL`. Use a dedicated provider (Helius, Triton, QuickNode);
  the public endpoint rate-limits heavily.
- **Code:** [`src/lib/server/solana.ts`](src/lib/server/solana.ts)

### Next.js + Vercel Cron: app and scheduler
- **App Router:** the dashboard UI plus two API routes: `/api/vault` (read-only state) and
  `/api/agent/tick` (runs the agent; needs `CRON_SECRET` in production).
- **Vercel Cron** ([`vercel.json`](vercel.json)) triggers a run every 30 minutes.

| Component | Role | Trust level |
|---|---|---|
| Squads | Custody and permissions | On-chain, hard guarantee |
| Wallet Adapter | Human approvals | Your key, your device |
| Claude | Decisions | Constrained by Squads + code guardrails |
| Jupiter | Execution | Quote checked before every trade |
| Pyth / Jupiter Price | Valuation | Confidence + staleness exposed to the agent |
| Agent hot wallet | Fees + small swaps | Low value by design |

## Modes: dry run and rules (no API key needed)

Two settings control how the agent behaves. Both apply to every run.

| Setting | Values | Default |
|---|---|---|
| `AGENT_MODE` | `claude`: the LLM decides · `rules`: a coded rebalancer decides (free) | `claude` if `ANTHROPIC_API_KEY` is set, else `rules` |
| `AGENT_DRY_RUN` | `true`: decide and fetch real Jupiter quotes, but **send no transactions** · `false`: trade for real | `true` |

**Rules mode** ([`src/lib/server/rules.ts`](src/lib/server/rules.ts)): when any asset in
`AGENT_TARGET` (default `USDC:50,SOL:50`) is more than `AGENT_DRIFT_PCT` points off target,
it moves value from the most overweight asset to the most underweight one. Trades up to the
auto cap go through the spending limit; larger ones become proposals. It waits while a
proposal is open and keeps `AGENT_SOL_RESERVE` SOL in the vault for fees.

Both modes go through the same guarded actions ([`src/lib/server/actions.ts`](src/lib/server/actions.ts)),
so switching modes or turning off dry run doesn't bypass any guardrail. The dashboard shows
the current mode and a **Dry run** badge.

Suggested path: run **rules + dry run**, then **rules for real** with small amounts, then
**Claude + dry run**, then **Claude for real**.

## Guardrails, in order of strength

1. **On-chain (Squads):** the agent's key has *Initiate* permission only, so it can
   propose but never approve or execute. Its spending limit (default 50 USDC + 0.25 SOL
   per day) can pay out only to the agent's own wallet.
2. **In code** (`src/lib/server/agent.ts`): a token allowlist, a USD cap on auto trades,
   a USD cap per proposal, a slippage cap, and a maximum number of actions per run.
3. **Human:** every trade above the auto cap becomes a Squads proposal you approve in the UI.

**Small trade:** the spending limit sends tokens to the agent wallet, the agent swaps
them on Jupiter, and the output goes back to the vault.
**Large trade:** the Jupiter swap (with the vault as the user) is wrapped in a Squads
vault transaction and a proposal is opened. You approve it, then execute it.

## Setup

Requires Node ≥ 20.19 (`nvm use` picks up `.nvmrc`).

```bash
npm install
cp .env.example .env.local
npm run gen:agent-key        # paste AGENT_SECRET_KEY into .env.local
# add ANTHROPIC_API_KEY (and optionally PYTH_API_KEY, NEXT_PUBLIC_RPC_URL)
npm run setup:vault          # uses ~/.config/solana/id.json as the human owner
# paste the printed NEXT_PUBLIC_MULTISIG_ADDRESS / SPENDING_LIMIT_* into .env.local
# send ~0.05 SOL to the agent address for fees
npm run dev
```

Open http://localhost:3000, connect the wallet you used for setup, deposit, and click
**Run agent now**.

> Jupiter is mainnet-only. Start with a small amount, around $20. The setup script
> spends a little SOL on account rent and fees.

## Deploying

`vercel.json` runs `/api/agent/tick` every 30 minutes. Set `CRON_SECRET` in production.
The tick route rejects calls without it.

## Known limits and next steps

- **Log storage:** `data/agent-log.json` only works locally. Use Postgres, Supabase or KV on Vercel.
- **Large Jupiter routes** may not fit in one vault transaction. Quotes use
  `maxAccounts=24` to prevent this. Squads *transaction buffers* would remove the limit.
- **Prices:** Pyth Hermes needs an API key since the Aug 2026 Core upgrade. Without
  `PYTH_API_KEY` the agent uses Jupiter's price API.
- **News or social inputs:** if you add them, treat them as untrusted (prompt
  injection). The on-chain limits are the backstop.
- **Other ideas:** an approval notification (Telegram or email), per-proposal stale-quote
  checks before execute, and a backtest harness for the mandate.
