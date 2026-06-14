/**
 * SMART MONEY TRACKER — Scout Giornaliero
 * ────────────────────────────────────────
 * Eseguito gratuitamente ogni 24h da GitHub Actions.
 * Analizza i wallet, calcola gli score, aggiorna:
 *   1. Upstash Redis (usato dal webhook per filtrare le tx)
 *   2. Supabase (storico e statistiche)
 *   3. Helius Webhook (aggiorna gli indirizzi da monitorare)
 */

import { Redis } from "https://esm.sh/@upstash/redis@1.28.4";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

// ─── ENV ──────────────────────────────────────────────────────────────────────
const HELIUS_API_KEY = Deno.env.get("HELIUS_API_KEY")!;
const HELIUS_WEBHOOK_ID = Deno.env.get("HELIUS_WEBHOOK_ID")!;  // creato al primo setup
const DENO_WEBHOOK_URL = Deno.env.get("DENO_WEBHOOK_URL")!;    // URL del tuo deploy Deno
const WEBHOOK_SECRET = Deno.env.get("HELIUS_WEBHOOK_SECRET")!;
const BIRDEYE_API_KEY = Deno.env.get("BIRDEYE_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_KEY")!;
const UPSTASH_REDIS_REST_URL = Deno.env.get("UPSTASH_REDIS_REST_URL")!;
const UPSTASH_REDIS_REST_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!;
const TOP_N = parseInt(Deno.env.get("TOP_WALLET_COUNT") || "20");

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── STEP 1: RACCOGLI WALLET CANDIDATI ────────────────────────────────────────
async function fetchCandidates(): Promise<string[]> {
  const wallets = new Set<string>();

  // Fonte A: Birdeye top traders (ultimi 30 giorni)
  if (BIRDEYE_API_KEY) {
    try {
      const res = await fetch(
        "https://public-api.birdeye.so/trader/gainers-losers?type=30D&sort_by=PnL&sort_type=desc&offset=0&limit=100",
        { headers: { "X-API-KEY": BIRDEYE_API_KEY }, signal: AbortSignal.timeout(8000) }
      );
      const data = await res.json() as { data?: { items?: Array<{ address: string }> } };
      (data?.data?.items || []).forEach((w) => w.address && wallets.add(w.address));
      console.log(`[Seed] Birdeye: ${wallets.size} wallet`);
    } catch (e) {
      console.warn("[Seed] Birdeye fallito:", (e as Error).message);
    }
  }

  // Fonte B: wallet già in DB con score > 40 (preserve buoni performer)
  try {
    const { data } = await supabase
      .from("top_wallets")
      .select("address")
      .gte("composite_score", 40);
    (data || []).forEach((w: { address: string }) => wallets.add(w.address));
    console.log(`[Seed] DB precedente: totale candidati ${wallets.size}`);
  } catch (e) {
    console.warn("[Seed] DB fallito:", (e as Error).message);
  }

  // Fonte C: top token Solana recenti → estrai i trader
  try {
    const topTokens = await fetchTopTokens();
    for (const token of topTokens.slice(0, 10)) {
      const traders = await fetchTokenTopTraders(token);
      traders.forEach((w) => wallets.add(w));
      await sleep(300);
    }
    console.log(`[Seed] Post token scan: ${wallets.size} candidati totali`);
  } catch (e) {
    console.warn("[Seed] Token scan fallito:", (e as Error).message);
  }

  return Array.from(wallets);
}

async function fetchTopTokens(): Promise<string[]> {
  if (!BIRDEYE_API_KEY) return [];
  const res = await fetch(
    "https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=20&min_liquidity=50000",
    { headers: { "X-API-KEY": BIRDEYE_API_KEY }, signal: AbortSignal.timeout(6000) }
  );
  const data = await res.json() as { data?: { tokens?: Array<{ address: string }> } };
  return (data?.data?.tokens || []).map((t) => t.address);
}

async function fetchTokenTopTraders(tokenAddress: string): Promise<string[]> {
  if (!BIRDEYE_API_KEY) return [];
  try {
    const res = await fetch(
      `https://public-api.birdeye.so/defi/txs/token?address=${tokenAddress}&tx_type=swap&limit=30`,
      { headers: { "X-API-KEY": BIRDEYE_API_KEY }, signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json() as { data?: { items?: Array<{ owner: string }> } };
    return (data?.data?.items || []).map((tx) => tx.owner).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── STEP 2: ANALIZZA SINGOLO WALLET ─────────────────────────────────────────
interface Trade {
  signature: string;
  timestamp: number;
  daysAgo: number;
  inputUsd: number;
  outputUsd: number;
  pnlUsd: number;
  roi: number;
}

interface WalletScore {
  address: string;
  composite_score: number;
  total_pnl_usd: number;
  pnl_30d_usd: number;
  pnl_7d_usd: number;
  avg_roi: number;
  win_rate: number;
  trade_count: number;
  trade_count_30d: number;
  sharpe_ratio: number;
  avg_trade_size_usd: number;
  last_active_at: string;
  updated_at: string;
}

async function analyzeWallet(address: string): Promise<WalletScore | null> {
  try {
    const txs = await fetchWalletSwaps(address);
    const trades = txs.map(parseTrade).filter((t): t is Trade => t !== null);

    if (trades.length < 8) return null; // Troppo pochi dati

    return computeScore(address, trades);
  } catch (e) {
    console.error(`[Analyze] ${address.slice(0, 8)}:`, (e as Error).message);
    return null;
  }
}

async function fetchWalletSwaps(address: string): Promise<Record<string, unknown>[]> {
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&type=SWAP&limit=100`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  return res.json();
}

function parseTrade(tx: Record<string, unknown>): Trade | null {
  try {
    const swap = (tx.events as Record<string, unknown>)?.swap as Record<string, unknown>;
    if (!swap) return null;

    const inputs = swap.tokenInputs as Array<Record<string, unknown>>;
    const outputs = swap.tokenOutputs as Array<Record<string, unknown>>;
    if (!inputs?.length || !outputs?.length) return null;

    const inputUsd = ((inputs[0].tokenAmount as number) || 0) * ((inputs[0].tokenPriceUSD as number) || 0);
    const outputUsd = ((outputs[0].tokenAmount as number) || 0) * ((outputs[0].tokenPriceUSD as number) || 0);
    if (inputUsd === 0) return null;

    const timestamp = (tx.timestamp as number) * 1000;
    const daysAgo = (Date.now() - timestamp) / 86_400_000;
    const pnlUsd = outputUsd - inputUsd;

    return {
      signature: tx.signature as string,
      timestamp,
      daysAgo,
      inputUsd,
      outputUsd,
      pnlUsd,
      roi: pnlUsd / inputUsd,
    };
  } catch {
    return null;
  }
}

function computeScore(address: string, trades: Trade[]): WalletScore | null {
  const recent30 = trades.filter((t) => t.daysAgo <= 30);
  const recent7 = trades.filter((t) => t.daysAgo <= 7);
  if (recent30.length < 5) return null;

  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const pnl30d = recent30.reduce((s, t) => s + t.pnlUsd, 0);
  const pnl7d = recent7.reduce((s, t) => s + t.pnlUsd, 0);
  const totalInvested = trades.reduce((s, t) => s + Math.abs(t.inputUsd), 0);
  const avgRoi = trades.reduce((s, t) => s + t.roi, 0) / trades.length;
  const winRate = trades.filter((t) => t.pnlUsd > 0).length / trades.length;

  // Escludiamo wallet con volume sospetto (market maker / bot ad alto volume)
  if (totalInvested > 10_000_000) return null;

  // Sharpe semplificato
  const variance = trades.reduce((s, t) => s + Math.pow(t.roi - avgRoi, 2), 0) / trades.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? avgRoi / stdDev : 0;

  // Score composito 0–100
  const winScore    = Math.min(winRate * 100, 100) * 0.25;
  const roiScore    = Math.min(Math.max(avgRoi * 50, 0), 100) * 0.25;
  const pnlScore    = Math.min(Math.max(pnl30d / 1000, 0), 100) * 0.20;
  const sharpeScore = Math.min(Math.max(sharpe * 20, 0), 100) * 0.15;
  const recency     = Math.min((recent7.length / 5) * 100, 100) * 0.15;

  const compositeScore = winScore + roiScore + pnlScore + sharpeScore + recency;

  return {
    address,
    composite_score: Math.round(compositeScore * 10) / 10,
    total_pnl_usd: Math.round(totalPnl),
    pnl_30d_usd: Math.round(pnl30d),
    pnl_7d_usd: Math.round(pnl7d),
    avg_roi: Math.round(avgRoi * 10000) / 100,
    win_rate: Math.round(winRate * 10000) / 100,
    trade_count: trades.length,
    trade_count_30d: recent30.length,
    sharpe_ratio: Math.round(sharpe * 100) / 100,
    avg_trade_size_usd: Math.round(totalInvested / trades.length),
    last_active_at: new Date(Math.max(...trades.map((t) => t.timestamp))).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ─── STEP 3: AGGIORNA HELIUS WEBHOOK ─────────────────────────────────────────
async function updateHeliusWebhook(walletAddresses: string[]) {
  // Se non esiste ancora, crea il webhook; altrimenti aggiorna
  if (!HELIUS_WEBHOOK_ID) {
    console.log("[Helius] HELIUS_WEBHOOK_ID non impostato, skip aggiornamento webhook");
    return;
  }

  const res = await fetch(
    `https://api.helius.xyz/v0/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookURL: `${DENO_WEBHOOK_URL}/webhook`,
        accountAddresses: walletAddresses,
        transactionTypes: ["SWAP"],
        webhookType: "enhanced",
        authHeader: WEBHOOK_SECRET,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error("[Helius] Webhook update fallito:", err);
  } else {
    console.log(`[Helius] Webhook aggiornato con ${walletAddresses.length} wallet`);
  }
}

// ─── STEP 4: AGGIORNA REDIS + SUPABASE ───────────────────────────────────────
async function persistResults(topWallets: WalletScore[]) {
  const addresses = topWallets.map((w) => w.address);

  // Redis: aggiorna il set dei top wallet (usato dal webhook in tempo reale)
  await redis.del("smm:top_wallets");
  if (addresses.length > 0) {
    await redis.sadd("smm:top_wallets", ...addresses);
  }
  await redis.set("smm:total_wallets", String(addresses.length));

  // Notifica al webhook Deno di ricaricare i wallet
  try {
    await fetch(`${DENO_WEBHOOK_URL}/wallets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "authorization": WEBHOOK_SECRET,
      },
      body: JSON.stringify({ wallets: addresses }),
    });
  } catch (e) {
    console.warn("[Deno] Update wallets fallito:", (e as Error).message);
  }

  // Supabase: salva storico score
  try {
    const { error } = await supabase
      .from("top_wallets")
      .upsert(topWallets, { onConflict: "address" });
    if (error) console.error("[Supabase] Upsert errore:", error.message);

    // Rimuovi wallet caduti fuori dalla top N
    if (addresses.length >= TOP_N) {
      await supabase
        .from("top_wallets")
        .delete()
        .not("address", "in", `(${addresses.map((a) => `'${a}'`).join(",")})`);
    }

    // Log run
    await supabase.from("scouting_runs").insert({
      wallet_count: topWallets.length,
      top_score: topWallets[0]?.composite_score,
      avg_score: Math.round(
        topWallets.reduce((s, w) => s + w.composite_score, 0) / topWallets.length
      ),
      candidates_analyzed: topWallets.length,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[Supabase] Errore:", (e as Error).message);
  }

  console.log(`[DB] ${addresses.length} wallet persistiti`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Smart Money Scout ===", new Date().toISOString());

  // 1. Raccolta candidati
  const candidates = await fetchCandidates();
  console.log(`[Scout] ${candidates.length} candidati da analizzare`);

  // 2. Analisi in batch (rispetta rate limit free tier)
  const results: WalletScore[] = [];
  const BATCH = 3;
  const DELAY = 800;

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const scores = await Promise.all(batch.map(analyzeWallet));
    scores.filter((s): s is WalletScore => s !== null).forEach((s) => results.push(s));

    if (i % 15 === 0) {
      console.log(`[Scout] ${i}/${candidates.length} analizzati, validi: ${results.length}`);
    }
    await sleep(DELAY);
  }

  // 3. Ordina e prendi top N
  results.sort((a, b) => b.composite_score - a.composite_score);
  const top = results.slice(0, TOP_N);

  console.log(`\n[Scout] TOP ${top.length} WALLET:`);
  top.forEach((w, i) => {
    console.log(
      `  ${i + 1}. ${w.address.slice(0, 8)}... score=${w.composite_score} winRate=${w.win_rate}% pnl30d=$${w.pnl_30d_usd}`
    );
  });

  // 4. Persisti risultati
  await persistResults(top);

  // 5. Aggiorna Helius webhook con nuovi wallet
  await updateHeliusWebhook(top.map((w) => w.address));

  console.log("\n[Scout] Completato.");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("[FATAL]", e);
  Deno.exit(1);
});
