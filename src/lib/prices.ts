import { TOKENS } from "./config";

// Since the Pyth Core upgrade (Aug 2026) Hermes requires an API key as a Bearer token.
// Without PYTH_API_KEY we fall back to Jupiter's keyless price API.
const HERMES = process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network";
const JUP_PRICE = "https://lite-api.jup.ag/price/v3";

export type Price = {
  symbol: string;
  usd: number;
  /** Pyth confidence interval in USD; 0 when the source doesn't provide one. */
  confidence: number;
  /** Unix seconds. */
  publishTime: number;
  source: "pyth" | "jupiter";
};

/** Latest USD prices for every allowlisted token. */
export async function getPrices(): Promise<Record<string, Price>> {
  const key = process.env.PYTH_API_KEY;
  return key ? getPythPrices(key) : getJupiterPrices();
}

async function getPythPrices(apiKey: string): Promise<Record<string, Price>> {
  const url = new URL(`${HERMES}/v2/updates/price/latest`);
  for (const t of TOKENS) url.searchParams.append("ids[]", t.pythFeedId);
  url.searchParams.set("parsed", "true");

  const res = await fetch(url, { cache: "no-store", headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Pyth Hermes ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as {
    parsed: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[];
  };

  const out: Record<string, Price> = {};
  for (const feed of body.parsed) {
    const token = TOKENS.find((t) => t.pythFeedId === feed.id.replace(/^0x/, ""));
    if (!token) continue;
    const scale = 10 ** feed.price.expo;
    out[token.symbol] = {
      symbol: token.symbol,
      usd: Number(feed.price.price) * scale,
      confidence: Number(feed.price.conf) * scale,
      publishTime: feed.price.publish_time,
      source: "pyth",
    };
  }
  return out;
}

async function getJupiterPrices(): Promise<Record<string, Price>> {
  const url = `${JUP_PRICE}?ids=${TOKENS.map((t) => t.mint).join(",")}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Jupiter price ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as Record<string, { usdPrice: number } | null>;

  const now = Math.floor(Date.now() / 1000);
  const out: Record<string, Price> = {};
  for (const t of TOKENS) {
    const p = body[t.mint];
    if (p) out[t.symbol] = { symbol: t.symbol, usd: p.usdPrice, confidence: 0, publishTime: now, source: "jupiter" };
  }
  return out;
}
