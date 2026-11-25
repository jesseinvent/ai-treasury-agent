import { NextRequest, NextResponse } from "next/server";
import { runAgentTick } from "@/lib/server/agent";
import { CRON_SECRET } from "@/lib/server/env";

// LLM + several confirmed transactions can take a while.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest) {
  // Local dev: allow the dashboard's "Run now" button without a secret.
  if (process.env.NODE_ENV !== "production" && !CRON_SECRET) return true;
  return CRON_SECRET !== "" && req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

// Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`.
export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const entry = await runAgentTick();
  return NextResponse.json(entry);
}

export const POST = GET;
