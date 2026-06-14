/**
 * SMART MONEY TRACKER — Scout Giornaliero v3
 * Fonti: GMGN leaderboard + Solana Tracker + wallet seme verificati
 */

import { Redis } from "https://esm.sh/@upstash/redis@1.28.4";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

const HELIUS_API_KEY = Deno.env.get("HELIUS_API_KEY")!;
const HELIUS_WEBHOOK_ID = Deno.env.get("HELIUS_WEBHOOK_ID")!;
const DENO_WEBHOOK_URL = Deno.env.get("DENO_WEBHOOK_URL")!;
const WEBHOOK_SECRET = Deno.env.get("HELIUS_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_KEY")!;
const UPSTASH_REDIS_REST_URL = Deno.env.get("UPSTASH_REDIS_REST_URL")!;
const UPSTASH_REDIS_REST_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!;
const TOP_N = parseInt(Deno.env.get("TOP_WALLET_COUNT") || "20");

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── WALLET SEME VERIFICATI ───────────────────────────────────────────────────
// Questi sono indirizzi di trader reali documentati pubblicamente,
// NON indirizzi di programmi DEX. Hanno storia di swap personali.
const SEED_WALLETS = [
  // Da Medium/GMGN - trader documentati con buon PnL
  "AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm",
  "4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t",
  "8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd",
  "H72yLkhTnoBfhBTXXaj1RBXuirm8s8G5fcVh2XpQLggM",
  // Wallet noti dalla community Solana smart money
  "CuieVDEDtLo7FypDHQcwyP6FastwZTEfYkLMApmmCPQs",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "Ap9PBmEGpqkb3sPzFRQRNanGFGoCx38CnBnYC7JiSKuL",
  "7cnh8MFpGAgmkCRUEoJMjZVbLRDeqpRMUBB8UPELmtj7",
  "HWHvQhFmJB3NUcu1aihKmrKegfVxBEHzwVX6yZCKEsi1",
];

// ─── FONTE 1: SOLANA TRACKER API (gratuita, no key) ──────────────────────────
async function fetchFromSolanaTracker(): Promise<string[]> {
  try {
    const res = await fetch(
      "https://data.solanatracker.io/top-traders?period=7d&limit=50",
      {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) {
      console.warn("[SolanaTracker] HTTP", res.status);
      return [];
    }
    const data = await res.json() as Array<{ wallet?: string; address?: string }>;
    const wallets = data
      .map((t) => t.wallet || t.address)
      .filter((w): w is string => !!w && w.length > 30);
    console.log(`[SolanaTracker] ${wallets.length} wallet trovati`);
    return wallets;
  } catch (e) {
    console.warn("[SolanaTracker] Fallito:", (e as Error).message);
    return [];
  }
}

// ─── FONTE 2: GMGN Smart Money leaderboard (pubblico) ────────────────────────
async function fetchFromGMGN(): Promise<string[]> {
  try {
    const res = await fetch(
      "https://gmgn.ai/api/v1/rank/sol/wallets/7d?orderby=pnl&direction=desc&limit=50",
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0",
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) {
      console.warn("[GMGN] HTTP", res.status);
      return [];
    }
    const data = await res.json() as { data?: { rank?: Array<{ wallet_address?: string }> } };
    const wallets = (data?.data?.rank || [])
      .map((t) => t.wallet_address)
      .filter((w): w is string => !!w && w.length > 30);
    console.log(`[GMGN] ${wallets.length} wallet trovati`);
    return wallets;
  } catch (e) {
    console.warn("[GMGN] Fallito:", (e as Error).message);
    return [];
  }
}

// ─── FONTE 3: Helius - trova trader dai token più scambiati oggi ──────────────
async function fetchFromHeliusTopTokens(): Promise<string[]> {
  try {
    // Token più popolari su Solana (hardcoded, stabili nel tempo)
    const hotTokens = [
      "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
      "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", // POPCAT
      "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",  // BOME
      "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzc8TU", // MYRO
    ];

    const discovered = new Set<string>();
    for (const token of hotTokens.slice(0, 3)) {
      try {
        const url = `https://api.helius.xyz/v0/addresses/${token}/transactions?api-key=${HELIUS_API_KEY}&type=SWAP&limit=50`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const txs = await res.json() as Array<{ feePayer?: string }>;
        txs.forEach((tx) => {
          if (tx.feePayer && tx.feePayer.length > 30) {
            discovered.add(tx.feePayer);
          }
        });
        await sleep(500);
      } catch {
        continue;
      }
    }
    const result = Array.from(discovered);
    console.log(`[Helius] ${result.length} wallet da token popolari`);
    return result;
  } catch (e) {
    console.warn("[Helius Discovery] Fallito:", (e as Error).message);
    return [];
  }
}

// ─── RACCOGLI TUTTI I CANDIDATI ───────────────────────────────────────────────
async function fetchCandidates(): Promise<string[]> {
  const wallets = new Set<string>();

  // Wallet seme verificati
  SEED_WALLETS.forEach((w) => wallets.add(w));
  console.log(`[Seed] Wallet seme: ${wallets.size}`);

  // DB precedente (si autoalimenta dopo il primo run valido)
  try {
    const { data } = await supabase
      .from("top_wallets")
      .select("address")
      .gte("composite_score", 20);
    (data || []).forEach((w: { address: string }) => wallets.add(w.address));
    console.log(`[Seed] Da DB: totale ${wallets.size}`);
  } catch (e) {
    console.warn("[Seed] DB:", (e as Error).message);
  }

  // Fonti esterne in parallelo
  const [solanaTracker, gmgn, helius] = await Promise.all([
    fetchFromSolanaTracker(),
    fetchFromGMGN(),
    fetchFromHeliusTopTokens(),
  ]);

  solanaTracker.forEach((w) => wallets.add(w));
  gmgn.forEach((w) => wallets.add(w));
  helius.forEach((w) => wallets.add(w));

  console.log(`[Seed] Totale candidati: ${wallets.size}`);
  return Array.from(wallets);
}

// ─── ANALISI WALLET ───────────────────────────────────────────────────────────
interface Trade {
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
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&type=SWAP&limit=100`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;

    const txs = await res.json() as Record<string, unknown>[];
    const trades: Trade[] = [];

    for (const tx of txs) {
      try {
        const swap = (tx.events as Record<string, unknown>)?.swap as Record<string, unknown>;
        if (!swap) continue;
        const inputs = swap.tokenInputs as Array<Record<string, unknown>>;
        const outputs = swap.tokenOutputs as Array<Record<string, unknown>>;
        if (!inputs?.length || !outputs?.length) continue;
        const inputUsd = ((inputs[0].tokenAmount as number) || 0) * ((inputs[0].tokenPriceUSD as number) || 0);
        const outputUsd = ((outputs[0].tokenAmount as number) || 0) * ((outputs[0].tokenPriceUSD as number) || 0);
        if (inputUsd < 1) continue; // ignora trade minuscoli
        const timestamp = (tx.timestamp as number) * 1000;
        const pnlUsd = outputUsd - inputUsd;
        trades.push({
          timestamp,
          daysAgo: (Date.now() - timestamp) / 86_400_000,
          inputUsd,
          outputUsd,
          pnlUsd,
          roi: pnlUsd / inputUsd,
        });
      } catch { continue; }
    }

    if (trades.length < 3) return null;

    const recent30 = trades.filter((t) => t.daysAgo <= 30);
    const recent7 = trades.filter((t) => t.daysAgo <= 7);
    if (recent30.length < 2) return null;

    const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
    const pnl30d = recent30.reduce((s, t) => s + t.pnlUsd, 0);
    const pnl7d = recent7.reduce((s, t) => s + t.pnlUsd, 0);
    const totalInvested = trades.reduce((s, t) => s + Math.abs(t.inputUsd), 0);
    const avgRoi = trades.reduce((s, t) => s + t.roi, 0) / trades.length;
    const winRate = trades.filter((t) => t.pnlUsd > 0).length / trades.length;

    if (totalInvested > 10_000_000) return null;

    const variance = trades.reduce((s, t) => s + Math.pow(t.roi - avgRoi, 2), 0) / trades.length;
    const sharpe = Math.sqrt(variance) > 0 ? avgRoi / Math.sqrt(variance) : 0;

    const compositeScore =
      Math.min(winRate * 100, 100) * 0.25 +
      Math.min(Math.max(avgRoi * 50, 0), 100) * 0.25 +
      Math.min(Math.max(pnl30d / 500, 0), 100) * 0.20 +
      Math.min(Math.max(sharpe * 20, 0), 100) * 0.15 +
      Math.min((recent7.length / 3) * 100, 100) * 0.15;

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
  } catch (e) {
    console.error(`[Analyze] ${address.slice(0, 8)}:`, (e as Error).message);
    return null;
  }
}

// ─── AGGIORNA HELIUS WEBHOOK ──────────────────────────────────────────────────
async function updateHeliusWebhook(addresses: string[]) {
  if (!HELIUS_WEBHOOK_ID || addresses.length === 0) return;
  const res = await fetch(
    `https://api.helius.xyz/v0/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookURL: `${DENO_WEBHOOK_URL}/webhook`,
        accountAddresses: addresses,
        transactionTypes: ["SWAP"],
        webhookType: "enhanced",
        authHeader: WEBHOOK_SECRET,
      }),
    }
  );
  if (!res.ok) console.error("[Helius] Webhook update fallito:", await res.text());
  else console.log(`[Helius] Webhook aggiornato con ${addresses.length} wallet`);
}

// ─── PERSISTI RISULTATI ───────────────────────────────────────────────────────
async function persistResults(topWallets: WalletScore[]) {
  const addresses = topWallets.map((w) => w.address);
  await redis.del("smm:top_wallets");
  if (addresses.length > 0) await redis.sadd("smm:top_wallets", ...addresses);
  await redis.set("smm:total_wallets", String(addresses.length));

  try {
    const { error } = await supabase.from("top_wallets").upsert(topWallets, { onConflict: "address" });
    if (error) console.error("[Supabase] Errore:", error.message);
    await supabase.from("scouting_runs").insert({
      wallet_count: topWallets.length,
      top_score: topWallets[0]?.composite_score,
      avg_score: Math.round(topWallets.reduce((s, w) => s + w.composite_score, 0) / (topWallets.length || 1)),
      candidates_analyzed: topWallets.length,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[Supabase] Errore:", (e as Error).message);
  }
  console.log(`[DB] ${addresses.length} wallet salvati`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Smart Money Scout v3 ===", new Date().toISOString());

  const candidates = await fetchCandidates();
  console.log(`[Scout] Analizzo ${candidates.length} candidati...`);

  const results: WalletScore[] = [];
  for (let i = 0; i < candidates.length; i += 3) {
    const batch = candidates.slice(i, i + 3);
    const scores = await Promise.all(batch.map(analyzeWallet));
    scores.filter((s): s is WalletScore => s !== null).forEach((s) => results.push(s));
    if (i % 15 === 0) console.log(`[Scout] ${i}/${candidates.length} analizzati, validi: ${results.length}`);
    await sleep(600);
  }

  results.sort((a, b) => b.composite_score - a.composite_score);
  const top = results.slice(0, TOP_N);

  console.log(`\n[Scout] TOP ${top.length} WALLET TROVATI:`);
  top.forEach((w, i) => {
    console.log(`  ${i + 1}. ${w.address.slice(0, 8)}... score=${w.composite_score} win=${w.win_rate}% pnl30d=$${w.pnl_30d_usd}`);
  });

  if (top.length === 0) {
    console.warn("[Scout] ATTENZIONE: nessun wallet valido trovato. Controlla la Helius API key.");
    return;
  }

  await persistResults(top);
  await updateHeliusWebhook(top.map((w) => w.address));
  console.log("\n[Scout] Completato con successo.");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => { console.error("[FATAL]", e); Deno.exit(1); });
