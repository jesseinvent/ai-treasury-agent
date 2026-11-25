import "server-only";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import { MULTISIG_ADDRESS, RPC_URL, SOL_MINT, TOKENS, VAULT_INDEX } from "../config";

export const connection = new Connection(RPC_URL, "confirmed");

export function multisigPda(): PublicKey {
  if (!MULTISIG_ADDRESS) throw new Error("NEXT_PUBLIC_MULTISIG_ADDRESS is not set. Run `npm run setup:vault`.");
  return new PublicKey(MULTISIG_ADDRESS);
}

export function vaultPda(): PublicKey {
  const [vault] = multisig.getVaultPda({ multisigPda: multisigPda(), index: VAULT_INDEX });
  return vault;
}

export type Holding = { symbol: string; mint: string; amount: number; raw: string; decimals: number };

/** Balances of every allowlisted token held by `owner` (SOL counted as native lamports). */
export async function getHoldings(owner: PublicKey): Promise<Holding[]> {
  const [lamports, tokenAccounts] = await Promise.all([
    connection.getBalance(owner),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
  ]);

  const byMint = new Map<string, bigint>();
  for (const { account } of tokenAccounts.value) {
    const info = account.data.parsed.info as { mint: string; tokenAmount: { amount: string } };
    byMint.set(info.mint, (byMint.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
  }

  return TOKENS.map((t) => {
    const raw = t.mint === SOL_MINT ? BigInt(lamports) : (byMint.get(t.mint) ?? 0n);
    return {
      symbol: t.symbol,
      mint: t.mint,
      decimals: t.decimals,
      raw: raw.toString(),
      amount: t.mint === SOL_MINT ? lamports / LAMPORTS_PER_SOL : Number(raw) / 10 ** t.decimals,
    };
  });
}
