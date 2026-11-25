// Shared config. Values here are safe to import from both server and client
// code; secrets live in src/lib/server/*.ts and are only read on the server.

export const CLUSTER = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "mainnet-beta") as
  | "mainnet-beta"
  | "devnet";

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ??
  (CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");

/** The Squads multisig that owns the treasury vault (printed by `npm run setup:vault`). */
export const MULTISIG_ADDRESS = process.env.NEXT_PUBLIC_MULTISIG_ADDRESS ?? "";
export const VAULT_INDEX = 0;

export type TokenInfo = {
  symbol: string;
  mint: string;
  decimals: number;
  /** Pyth Hermes price feed id (hex, no 0x). */
  pythFeedId: string;
};

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * The ONLY tokens the agent may hold or trade. Anything else is rejected in code,
 * whatever the model asks for. Mainnet mints; Jupiter is mainnet-only.
 */
export const TOKENS: TokenInfo[] = [
  {
    symbol: "SOL",
    mint: SOL_MINT,
    decimals: 9,
    pythFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  },
  {
    symbol: "USDC",
    mint: USDC_MINT,
    decimals: 6,
    pythFeedId: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  },
  {
    symbol: "JUP",
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    decimals: 6,
    pythFeedId: "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  },
  {
    symbol: "BONK",
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    decimals: 5,
    pythFeedId: "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
  },
];

export const tokenBySymbol = (symbol: string) =>
  TOKENS.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase());

export const tokenByMint = (mint: string) => TOKENS.find((t) => t.mint === mint);
