"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import { CLUSTER, MULTISIG_ADDRESS, USDC_MINT } from "@/lib/config";

// The wallet button reads window state, so render it client-side only.
const WalletMultiButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);

type VaultData = {
  vault: string;
  agent: string;
  mode: "claude" | "rules";
  dryRun: boolean;
  totalUsd: number;
  holdings: { symbol: string; amount: number; usd: number }[];
  proposals: { transactionIndex: string; status: string; approved: string[]; rejected: string[] }[];
  log: {
    id: string;
    at: string;
    kind: string;
    summary: string;
    reasoning?: string;
    txSignature?: string;
    transactionIndex?: string;
  }[];
  error?: string;
};

const explorer = (sig: string) =>
  `https://solscan.io/tx/${sig}${CLUSTER === "devnet" ? "?cluster=devnet" : ""}`;

export function Dashboard() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [data, setData] = useState<VaultData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");

  const refresh = useCallback(async () => {
    const res = await fetch("/api/vault", { cache: "no-store" });
    setData(await res.json());
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  /** Build a v0 transaction, have the connected wallet sign + send it, and confirm. */
  async function send(label: string, ixs: TransactionInstruction[], luts: AddressLookupTableAccount[] = []) {
    if (!publicKey) return setStatus("Connect a wallet first.");
    setBusy(label);
    setStatus(`${label}: waiting for wallet…`);
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const tx = new VersionedTransaction(
        new TransactionMessage({ payerKey: publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(luts),
      );
      const sig = await sendTransaction(tx, connection);
      setStatus(`${label}: confirming ${sig.slice(0, 8)}…`);
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      setStatus(`${label}: done ✓`);
      await refresh();
    } catch (e) {
      setStatus(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function deposit(symbol: "SOL" | "USDC", amount: number) {
    if (!publicKey || !data?.vault || !(amount > 0)) return;
    const vault = new PublicKey(data.vault);
    if (symbol === "SOL") {
      return send("Deposit", [
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: vault, lamports: Math.round(amount * LAMPORTS_PER_SOL) }),
      ]);
    }
    const mint = new PublicKey(USDC_MINT);
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
    return send("Deposit", [
      createAssociatedTokenAccountIdempotentInstruction(publicKey, vaultAta, vault, mint),
      createTransferInstruction(
        getAssociatedTokenAddressSync(mint, publicKey),
        vaultAta,
        publicKey,
        BigInt(Math.round(amount * 1e6)),
      ),
    ]);
  }

  const msPda = MULTISIG_ADDRESS ? new PublicKey(MULTISIG_ADDRESS) : null;

  async function vote(index: string, approve: boolean) {
    if (!publicKey || !msPda) return;
    const args = { multisigPda: msPda, transactionIndex: BigInt(index), member: publicKey };
    await send(
      approve ? "Approve" : "Reject",
      [approve ? multisig.instructions.proposalApprove(args) : multisig.instructions.proposalReject(args)],
    );
  }

  async function execute(index: string) {
    if (!publicKey || !msPda) return;
    const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({
      connection,
      multisigPda: msPda,
      transactionIndex: BigInt(index),
      member: publicKey,
    });
    await send(
      "Execute",
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), instruction],
      lookupTableAccounts,
    );
  }

  async function runAgent() {
    setBusy("agent");
    setStatus("Agent thinking… (can take a minute)");
    try {
      const res = await fetch("/api/agent/tick", { method: "POST" });
      const entry = await res.json();
      setStatus(res.ok ? `Agent: ${entry.kind}` : `Agent error: ${entry.error ?? res.status}`);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const proposalLog = (index: string) => data?.log.find((l) => l.transactionIndex === index);

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            AI Treasury Agent
            {data && !data.error && (
              <>
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-normal">
                  {data.mode === "claude" ? "Claude" : "Rules"}
                </span>
                {data.dryRun && (
                  <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-normal text-amber-300">
                    Dry run: no trades sent
                  </span>
                )}
              </>
            )}
          </h1>
          <p className="text-sm text-zinc-400">
            Squads vault managed by Claude, guarded by on-chain spending limits and human approval.
          </p>
        </div>
        <WalletMultiButton />
      </header>

      {!MULTISIG_ADDRESS && (
        <Card>
          <p className="text-amber-400">
            No vault configured. Run <code>npm run setup:vault</code> and set NEXT_PUBLIC_MULTISIG_ADDRESS.
          </p>
        </Card>
      )}
      {data?.error && (
        <Card>
          <p className="text-red-400 text-sm break-all">{data.error}</p>
        </Card>
      )}

      {data && !data.error && (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <Card title="Vault">
              <p className="text-3xl font-semibold tabular-nums">
                ${data.totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </p>
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {data.holdings.map((h) => (
                    <tr key={h.symbol} className="border-t border-zinc-800">
                      <td className="py-1.5">{h.symbol}</td>
                      <td className="text-right tabular-nums">{h.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                      <td className="text-right tabular-nums text-zinc-400">${h.usd.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-zinc-500 break-all">Vault {data.vault}</p>
              <p className="text-xs text-zinc-500 break-all">Agent {data.agent}</p>
            </Card>

            <Card title="Deposit & run">
              <DepositForm disabled={!publicKey || !!busy} onDeposit={deposit} />
              <button
                onClick={runAgent}
                disabled={!!busy}
                className="mt-4 w-full rounded-lg bg-violet-600 px-4 py-2 font-medium hover:bg-violet-500 disabled:opacity-50"
              >
                {busy === "agent" ? "Agent running…" : "Run agent now"}
              </button>
              {status && <p className="mt-3 text-sm text-zinc-300 break-all">{status}</p>}
            </Card>
          </div>

          <Card title="Proposals (need human approval)">
            {data.proposals.length === 0 && <p className="text-sm text-zinc-500">None yet.</p>}
            <ul className="space-y-3">
              {data.proposals.map((p) => {
                const entry = proposalLog(p.transactionIndex);
                return (
                  <li key={p.transactionIndex} className="rounded-lg border border-zinc-800 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <span className="font-medium">#{p.transactionIndex}</span>{" "}
                        <span className="text-sm">{entry?.summary ?? "Vault transaction"}</span>
                        <span className="ml-2 rounded bg-zinc-800 px-2 py-0.5 text-xs">{p.status}</span>
                      </div>
                      <div className="flex gap-2">
                        {p.status === "Active" && (
                          <>
                            <Btn disabled={!publicKey || !!busy} onClick={() => vote(p.transactionIndex, true)}>Approve</Btn>
                            <Btn disabled={!publicKey || !!busy} onClick={() => vote(p.transactionIndex, false)} variant="ghost">Reject</Btn>
                          </>
                        )}
                        {p.status === "Approved" && (
                          <Btn disabled={!publicKey || !!busy} onClick={() => execute(p.transactionIndex)}>Execute</Btn>
                        )}
                      </div>
                    </div>
                    {entry?.reasoning && <p className="mt-2 text-sm text-zinc-400">{entry.reasoning}</p>}
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title="Agent log">
            {data.log.length === 0 && <p className="text-sm text-zinc-500">The agent hasn&apos;t run yet.</p>}
            <ul className="space-y-3">
              {data.log.map((l) => (
                <li key={l.id} className="border-t border-zinc-800 pt-3 text-sm">
                  <div className="flex gap-2 text-xs text-zinc-500">
                    <span>{new Date(l.at).toLocaleString()}</span>
                    <span className="uppercase">{l.kind}</span>
                    {l.txSignature && (
                      <a className="text-violet-400 hover:underline" href={explorer(l.txSignature)} target="_blank" rel="noreferrer">
                        tx
                      </a>
                    )}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap">{l.summary}</p>
                  {l.reasoning && <p className="mt-1 text-zinc-400">{l.reasoning}</p>}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </main>
  );
}

function DepositForm({
  disabled,
  onDeposit,
}: {
  disabled: boolean;
  onDeposit: (symbol: "SOL" | "USDC", amount: number) => void;
}) {
  const [symbol, setSymbol] = useState<"SOL" | "USDC">("USDC");
  const [amount, setAmount] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onDeposit(symbol, Number(amount));
      }}
    >
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        placeholder="Amount"
        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
      />
      <select
        value={symbol}
        onChange={(e) => setSymbol(e.target.value as "SOL" | "USDC")}
        className="rounded-lg border border-zinc-700 bg-zinc-900 px-2"
      >
        <option>USDC</option>
        <option>SOL</option>
      </select>
      <Btn disabled={disabled}>Deposit</Btn>
    </form>
  );
}

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
      {title && <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">{title}</h2>}
      {children}
    </section>
  );
}

function Btn({
  children,
  onClick,
  disabled,
  variant = "solid",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "solid" | "ghost";
}) {
  return (
    <button
      type={onClick ? "button" : "submit"}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
        variant === "solid" ? "bg-zinc-100 text-zinc-900 hover:bg-white" : "border border-zinc-700 hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}
