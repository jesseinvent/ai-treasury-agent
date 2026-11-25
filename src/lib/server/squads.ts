import "server-only";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import { SOL_MINT, VAULT_INDEX } from "../config";
import { agentKeypair, spendingLimits } from "./env";
import { getQuote, getSwapInstructions, getSwapTransaction, Quote } from "./jupiter";
import { connection, getHoldings, multisigPda, vaultPda } from "./solana";

async function sendV0(
  instructions: TransactionInstruction[],
  signer: Keypair,
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(message);
  tx.sign([signer]);
  return confirm(tx, blockhash, lastValidBlockHeight);
}

async function confirm(tx: VersionedTransaction, blockhash: string, lastValidBlockHeight: number) {
  const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}

const balanceOf = async (owner: PublicKey, mint: string) =>
  BigInt((await getHoldings(owner)).find((h) => h.mint === mint)?.raw ?? "0");

/**
 * Small trade, no human needed:
 *  1. Pull `amountRaw` of the input token out of the vault via the agent's Squads spending limit.
 *  2. Swap it on Jupiter from the agent's hot wallet.
 *  3. Send the output back to the vault.
 * The on-chain spending limit caps how much can leave the vault per period.
 */
export async function autoSwap(args: {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  decimals: number;
  slippageBps: number;
}) {
  const agent = agentKeypair();
  const vault = vaultPda();
  const limit = spendingLimits()[args.inputMint];
  if (!limit) throw new Error(`No spending limit configured for ${args.inputMint}; propose instead.`);

  // 1. Spending limit -> agent wallet
  const pullIxs: TransactionInstruction[] = [];
  const isSol = args.inputMint === SOL_MINT;
  if (!isSol) {
    const mint = new PublicKey(args.inputMint);
    pullIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        agent.publicKey,
        getAssociatedTokenAddressSync(mint, agent.publicKey),
        agent.publicKey,
        mint,
      ),
    );
  }
  pullIxs.push(
    multisig.instructions.spendingLimitUse({
      multisigPda: multisigPda(),
      member: agent.publicKey,
      spendingLimit: limit,
      mint: isSol ? undefined : new PublicKey(args.inputMint),
      vaultIndex: VAULT_INDEX,
      amount: Number(args.amountRaw),
      decimals: args.decimals,
      destination: agent.publicKey,
      memo: "ai-treasury-agent: auto swap",
    }),
  );
  const pullSig = await sendV0(pullIxs, agent);

  // 2. Swap from the hot wallet
  const before = await balanceOf(agent.publicKey, args.outputMint);
  const quote = await getQuote({ ...args, amountRaw: args.amountRaw });
  const swapTx = await getSwapTransaction(quote, agent.publicKey);
  swapTx.sign([agent]);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const swapSig = await confirm(swapTx, blockhash, lastValidBlockHeight);
  const after = await balanceOf(agent.publicKey, args.outputMint);
  const received = after - before;

  // 3. Return proceeds to the vault
  let returnSig: string | undefined;
  if (received > 0n) {
    const ixs: TransactionInstruction[] = [];
    if (args.outputMint === SOL_MINT) {
      ixs.push(SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: vault, lamports: received }));
    } else {
      const mint = new PublicKey(args.outputMint);
      const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, vaultAta, vault, mint),
        createTransferInstruction(
          getAssociatedTokenAddressSync(mint, agent.publicKey),
          vaultAta,
          agent.publicKey,
          received,
        ),
      );
    }
    returnSig = await sendV0(ixs, agent);
  }

  return { pullSig, swapSig, returnSig, quote, receivedRaw: received.toString() };
}

/**
 * Large trade: wrap a Jupiter swap (vault as the user) in a Squads vault
 * transaction and open a proposal. A human approves and executes it in the UI.
 */
export async function proposeSwap(args: {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps: number;
  memo: string;
}): Promise<{ transactionIndex: bigint; signature: string; quote: Quote }> {
  const agent = agentKeypair();
  const msPda = multisigPda();
  const vault = vaultPda();

  // maxAccounts keeps the route small enough to fit in vaultTransactionCreate.
  const quote = await getQuote({ ...args, maxAccounts: 24 });
  const { instructions, lookupTables } = await getSwapInstructions(quote, vault);

  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, msPda);
  const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  const { blockhash } = await connection.getLatestBlockhash();

  const createIx = multisig.instructions.vaultTransactionCreate({
    multisigPda: msPda,
    transactionIndex,
    creator: agent.publicKey,
    rentPayer: agent.publicKey,
    vaultIndex: VAULT_INDEX,
    ephemeralSigners: 0,
    transactionMessage: new TransactionMessage({
      payerKey: vault,
      recentBlockhash: blockhash,
      instructions,
    }),
    addressLookupTableAccounts: lookupTables,
    memo: args.memo.slice(0, 200),
  });
  const proposalIx = multisig.instructions.proposalCreate({
    multisigPda: msPda,
    transactionIndex,
    creator: agent.publicKey,
    rentPayer: agent.publicKey,
  });

  const signature = await sendV0([createIx, proposalIx], agent);
  return { transactionIndex, signature, quote };
}

export type ProposalView = {
  transactionIndex: string;
  status: string;
  approved: string[];
  rejected: string[];
};

/** Most recent proposals, newest first. */
export async function listProposals(count = 10): Promise<ProposalView[]> {
  const msPda = multisigPda();
  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, msPda);
  const latest = BigInt(ms.transactionIndex.toString());
  const out: ProposalView[] = [];
  for (let i = latest; i > 0n && out.length < count; i--) {
    const [pda] = multisig.getProposalPda({ multisigPda: msPda, transactionIndex: i });
    try {
      const p = await multisig.accounts.Proposal.fromAccountAddress(connection, pda);
      out.push({
        transactionIndex: i.toString(),
        status: p.status.__kind,
        approved: p.approved.map((k) => k.toBase58()),
        rejected: p.rejected.map((k) => k.toBase58()),
      });
    } catch {
      // Config transactions from setup, or proposals that were closed.
    }
  }
  return out;
}
