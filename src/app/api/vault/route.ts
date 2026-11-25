import { NextResponse } from "next/server";
import { getPrices } from "@/lib/prices";
import { agentKeypair, agentMode, isDryRun } from "@/lib/server/env";
import { readLog } from "@/lib/server/log";
import { getHoldings, vaultPda } from "@/lib/server/solana";
import { listProposals } from "@/lib/server/squads";

export const dynamic = "force-dynamic";

/** Everything the dashboard needs in one call. Read-only. */
export async function GET() {
  try {
    const vault = vaultPda();
    const [holdings, prices, proposals, log] = await Promise.all([
      getHoldings(vault),
      getPrices(),
      listProposals(10),
      readLog(50),
    ]);
    const rows = holdings.map((h) => ({ ...h, usd: h.amount * (prices[h.symbol]?.usd ?? 0) }));
    return NextResponse.json({
      vault: vault.toBase58(),
      agent: agentKeypair().publicKey.toBase58(),
      mode: agentMode(),
      dryRun: isDryRun(),
      totalUsd: rows.reduce((s, r) => s + r.usd, 0),
      holdings: rows,
      proposals,
      log,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
