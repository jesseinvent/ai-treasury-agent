// Generates a fresh agent hot key. Paste the output into .env.local.
// Keep this key low-value: it only holds SOL for fees, and the Squads
// spending limit caps what it can pull from the vault.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const kp = Keypair.generate();
console.log(`AGENT_SECRET_KEY=${bs58.encode(kp.secretKey)}`);
console.log(`# agent public key: ${kp.publicKey.toBase58()}`);
