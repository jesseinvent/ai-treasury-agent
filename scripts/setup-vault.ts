/**
 * One-time setup: create the Squads multisig + vault and give the agent a daily
 * spending limit. Run with your own CLI wallet as the human owner:
 *
 *   npm run setup:vault
 *
 * Env (from .env.local):
 *   AGENT_SECRET_KEY          agent hot key (only its public key is used here)
 *   HUMAN_KEYPAIR_PATH        defaults to ~/.config/solana/id.json
 *   SETUP_USDC_DAILY_LIMIT    default 50  (USDC the agent may move per day)
 *   SETUP_SOL_DAILY_LIMIT     default 0.25 (SOL the agent may move per day)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import * as multisig from "@sqds/multisig";

const { Permission, Permissions } = multisig.types;
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const rpc = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpc, "confirmed");

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));
}

function agentPublicKey(): PublicKey {
  const raw = process.env.AGENT_SECRET_KEY?.trim();
  if (!raw) throw new Error("Set AGENT_SECRET_KEY in .env.local first (npm run gen:agent-key).");
  const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  return Keypair.fromSecretKey(bytes).publicKey;
}

async function main() {
  const human = loadKeypair(
    process.env.HUMAN_KEYPAIR_PATH ?? path.join(os.homedir(), ".config/solana/id.json"),
  );
  const agent = agentPublicKey();
  console.log("Human owner:", human.publicKey.toBase58());
  console.log("Agent:      ", agent.toBase58());
  console.log("RPC:        ", rpc);

  // 1. Create the multisig. Humans vote and execute; the agent can only propose.
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(connection, programConfigPda);

  await multisig.rpc.multisigCreateV2({
    connection,
    treasury: programConfig.treasury,
    createKey,
    creator: human,
    multisigPda,
    configAuthority: null,
    threshold: 1,
    members: [
      { key: human.publicKey, permissions: Permissions.all() },
      { key: agent, permissions: Permissions.fromPermissions([Permission.Initiate]) },
    ],
    timeLock: 0,
    rentCollector: null,
    sendOptions: { skipPreflight: false },
  });
  await waitForAccount(multisigPda);
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
  console.log("\nMultisig created:", multisigPda.toBase58());
  console.log("Vault:          ", vault.toBase58());

  // 2. Add daily spending limits that only the agent can use, paying only to itself.
  const usdcLimit = Number(process.env.SETUP_USDC_DAILY_LIMIT ?? "50");
  const solLimit = Number(process.env.SETUP_SOL_DAILY_LIMIT ?? "0.25");
  const usdcKey = Keypair.generate().publicKey;
  const solKey = Keypair.generate().publicKey;
  const [usdcLimitPda] = multisig.getSpendingLimitPda({ multisigPda, createKey: usdcKey });
  const [solLimitPda] = multisig.getSpendingLimitPda({ multisigPda, createKey: solKey });

  const transactionIndex = 1n;
  const common = {
    vaultIndex: 0,
    period: multisig.types.Period.Day,
    members: [agent],
    destinations: [agent],
  };
  await multisig.rpc.configTransactionCreate({
    connection,
    feePayer: human,
    multisigPda,
    transactionIndex,
    creator: human.publicKey,
    actions: [
      {
        __kind: "AddSpendingLimit",
        createKey: usdcKey,
        mint: USDC_MINT,
        amount: Math.round(usdcLimit * 1e6),
        ...common,
      },
      {
        __kind: "AddSpendingLimit",
        createKey: solKey,
        mint: PublicKey.default, // SOL
        amount: Math.round(solLimit * LAMPORTS_PER_SOL),
        ...common,
      },
    ],
  });
  await multisig.rpc.proposalCreate({ connection, feePayer: human, creator: human, multisigPda, transactionIndex });
  await multisig.rpc.proposalApprove({ connection, feePayer: human, member: human, multisigPda, transactionIndex });
  const sig = await multisig.rpc.configTransactionExecute({
    connection,
    feePayer: human,
    multisigPda,
    transactionIndex,
    member: human,
    rentPayer: human,
    spendingLimits: [usdcLimitPda, solLimitPda],
  });
  await connection.confirmTransaction(sig, "confirmed");

  console.log(`\nSpending limits: ${usdcLimit} USDC/day and ${solLimit} SOL/day for the agent.`);
  console.log("\nAdd these to .env.local:\n");
  console.log(`NEXT_PUBLIC_MULTISIG_ADDRESS=${multisigPda.toBase58()}`);
  console.log(`SPENDING_LIMIT_USDC=${usdcLimitPda.toBase58()}`);
  console.log(`SPENDING_LIMIT_SOL=${solLimitPda.toBase58()}`);
  console.log(`\nThen fund the agent with ~0.05 SOL for fees: ${agent.toBase58()}`);
  console.log(`and deposit into the vault from the app: ${vault.toBase58()}`);
}

async function waitForAccount(address: PublicKey) {
  for (let i = 0; i < 30; i++) {
    if (await connection.getAccountInfo(address)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Account ${address.toBase58()} never appeared`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
