import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";

// A JSON-file log is enough for local dev. On Vercel the filesystem is
// read-only/ephemeral: swap this module for Postgres, Supabase, or KV.
const LOG_FILE = path.join(process.cwd(), "data", "agent-log.json");

export type LogEntry = {
  id: string;
  at: string;
  kind: "tick" | "auto_swap" | "proposal" | "dry_run" | "error";
  summary: string;
  reasoning?: string;
  txSignature?: string;
  transactionIndex?: string;
  details?: Record<string, unknown>;
};

export async function readLog(limit = 100): Promise<LogEntry[]> {
  try {
    const entries = JSON.parse(await fs.readFile(LOG_FILE, "utf8")) as LogEntry[];
    return entries.slice(-limit).reverse();
  } catch {
    return [];
  }
}

export async function appendLog(entry: Omit<LogEntry, "id" | "at">): Promise<LogEntry> {
  const full: LogEntry = { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry };
  let entries: LogEntry[] = [];
  try {
    entries = JSON.parse(await fs.readFile(LOG_FILE, "utf8"));
  } catch {
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
  }
  entries.push(full);
  await fs.writeFile(LOG_FILE, JSON.stringify(entries.slice(-1000), null, 2));
  return full;
}
