import "server-only";
import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { JUPITER_API } from "./env";
import { connection } from "./solana";

export type Quote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: { swapInfo: { label?: string } }[];
  [k: string]: unknown;
};

export async function getQuote(args: {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps: number;
  /** Keep routes small enough to fit inside a Squads vault transaction. */
  maxAccounts?: number;
}): Promise<Quote> {
  const url = new URL(`${JUPITER_API}/quote`);
  url.searchParams.set("inputMint", args.inputMint);
  url.searchParams.set("outputMint", args.outputMint);
  url.searchParams.set("amount", args.amountRaw.toString());
  url.searchParams.set("slippageBps", String(args.slippageBps));
  if (args.maxAccounts) url.searchParams.set("maxAccounts", String(args.maxAccounts));

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${await res.text()}`);
  return (await res.json()) as Quote;
}

/** A ready-to-sign swap transaction for a normal wallet (used by the agent's hot wallet). */
export async function getSwapTransaction(quote: Quote, user: PublicKey): Promise<VersionedTransaction> {
  const res = await fetch(`${JUPITER_API}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap ${res.status}: ${await res.text()}`);
  const { swapTransaction } = (await res.json()) as { swapTransaction: string };
  return VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
}

type RawIx = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};

const toIx = (ix: RawIx) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });

/**
 * Raw swap instructions with the Squads vault as the user, for wrapping in a
 * vault transaction. Compute-budget instructions are dropped: they can't run via CPI.
 */
export async function getSwapInstructions(quote: Quote, user: PublicKey) {
  const res = await fetch(`${JUPITER_API}/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap-instructions ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    setupInstructions: RawIx[];
    swapInstruction: RawIx;
    cleanupInstruction: RawIx | null;
    otherInstructions: RawIx[];
    addressLookupTableAddresses: string[];
  };

  const instructions = [
    ...body.setupInstructions.map(toIx),
    toIx(body.swapInstruction),
    ...(body.cleanupInstruction ? [toIx(body.cleanupInstruction)] : []),
  ];

  const lookupTables = (
    await Promise.all(
      body.addressLookupTableAddresses.map((a) => connection.getAddressLookupTable(new PublicKey(a))),
    )
  )
    .map((r) => r.value)
    .filter((v): v is AddressLookupTableAccount => v !== null);

  return { instructions, lookupTables };
}
