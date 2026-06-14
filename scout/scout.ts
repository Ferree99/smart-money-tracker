/**
 * SMART MONEY TRACKER — Scout Giornaliero
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

// ─── WALLET SEME ─────────────────────────────────────────────────────────────
// Lista di smart money wallet noti su Solana come punto di partenza.
// Lo scout li analizza, calcola gli score, e mantiene solo i migliori.
// Ogni giorno questa lista si arricchisce con nuovi wallet scoperti on-chain.
const SEED_WALLETS = [
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "CuieVDEDtLo7FypDHQcwyP6FastwZTEfYkLMApmmCPQs",
  "Ap9PBmEGpqkb3sPzFRQRNanGFGoCx38CnBnYC7JiSKuL",
  "7cnh8MFpGAgmkCRUEoJMjZVbLRDeqpRMUBB8UPELmtj7",
  "6AE4HMsQDLKpBnCbSFQFVkgEEEf7Hhg5RRfBsJLJGEKF",
  "GGztQqQ3V6YBQKBFpFVMhCkyeaHDnVFdBKz5SXqp5kzA",
  "5tzFkiKscXHK5ZXCGbXZxdw7gPcFNQMHKVXxGBrKGDdN",
  "HWHvQhFmJB3NUcu1aihKmrKegfVxBEHzwVX6yZCKEsi1",
  "4MR36ZfGHkDBfBqPRJDJFEbE4XpBtNqoUFVFpKTGQGsm",
  "3BHxPBtj5zQgxCkfEMZzFKnUWnkBQoQFmpCaJMhXq7Pz",
  "EhYXq3ANp5SbcMVMuHN5N1MFBR7P7pM2CsHRFzrKdmg",
  "BHgLFsYEVG8dJFkDMZbqLCPNaFMiNS2CSdGNDAkGPi3X",
  "2wrCEEHpWRxCpNGVFVmMkRmh5XJUrfBVBTwjTiZy1TE5",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bsn",
  "7qbRF6YsyGuFnmQVaGSqMbovBkG3MkMvC2GbkGqFXRkk",
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  "GDDMwNyyx8uB6zrqwBFHjLLG3TkTCpEkyki475Co5Yth",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
  "F7uuFMFTBMbFdGdCVwMQkGMgmJCYqHDrBqRoEi44i7nF",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "So11111111111111111111111111111111111111112",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3sFjJ97",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2pgJh",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
  "EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S",
];

// ─── FETCH CANDIDATI ──────────────────────────────────────────────────────────
async function fetchCandidates(): Promise<string[]> {
  const wallets = new Set<string>();

  // Fonte A: wallet seme hardcoded (sempre disponibili)
  SEED_WALLETS.forEach((w) => wallets.add(w));
  console.log(`[Seed] Wallet seme: ${wallets.size}`);

  // Fonte B: wallet già in DB con buon score (si autoalimenta dopo il primo run)
  try {
    const { data } = await supabase
      .from("top_wallets")
      .select("address")
      .gte("composite_score", 30);
    (data || []).forEach((w: { address: string }) => wallets.add(w.address));
    console.log(`[Seed] DB precedente: totale candidati ${wallets.size}`);
  } catch (e) {
    console.warn("[Seed] DB fallito:", (e as Error).message);
  }

  // Fonte C: scopri nuovi wallet dalle transazioni recenti dei wallet seme
  try {
    const seedSample = SEED_WALLETS.slice(0, 5); // prime 5 per non eccedere rate limit
    for (const seed of seedSample) {
      const newWallets = await discoverWalletsFromTrades(seed);
      newWallets.forEach((w) => wallets.add(w));
      await sleep(500);
    }
    console.log(`[Seed] Post discovery: ${wallets.size} candidati totali`);
  } catch (e) {
    console.warn("[Seed] Discovery fallita:", (e as Error).message);
  }

  return Array.from(wallets);
}

// Scopri wallet che hanno tradato gli stessi token di un wallet noto
async function discoverWalletsFromTrades(address: string): Promise<string[]> {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&type=SWAP&limit=10`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const txs = await res.json() as Record<string, unknown>[];

    // Estrai i token comprati
    const tokens = txs
      .map((tx) => {
        const swap = (tx.events as Record<string, unknown>)?.swap as Record<string, unknown>;
        return (swap?.tokenOutputs as Array<Record<string, unknown>>)?.[0]?.mint as string;
      })
      .filter(Boolean)
      .slice(0, 3);

    // Per ogni token, trova altri wallet che lo hanno comprato
    const discovered: string[] = [];
    for (const token of tokens) {
      const url2 = `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`;
      const txUrl = `https://api.helius.xyz/v0/addresses/${token}/transactions?api-key=${HELIUS_API_KEY}&type=SWAP&limit=20`;
      const res2 = await fetch(txUrl, { signal: AbortSignal.timeout(6000) });
      if (!res2.ok) continue;
      const txs2 = await res2.json() as Record<string, unknown>[];
      txs2.forEach((tx) => {
        const payer = tx.feePayer as string;
        if (payer) discovered.push(payer);
      });
      await sleep(300);
    }
    return discovered;
  } catch {
    return [];
  }
}

// ─── ANALISI WALLET ───────────────────────────────────────────────────────────
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
    if (trades.length < 5) return null;
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
    const pnlUsd = outputUsd - inputUsd;
    return {
      signature: tx.signature as string,
      timestamp,
      daysAgo: (Date.now() - timestamp) / 86_400_000,
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
  if (recent30.length < 3) return null;

  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const pnl30d = recent30.reduce((s, t) => s + t.pnlUsd, 0);
  const pnl7d = recent7.reduce((s, t) => s + t.pnlUsd, 0);
  const totalInvested = trades.reduce((s, t) => s + Math.abs(t.inputUsd), 0);
  const avgRoi = trades.reduce((s, t) => s + t.roi, 0) / trades.length;
  const winRate = trades.filter((t) => t.pnlUsd > 0).length / trades.length;

  if (totalInvested > 10_000_000) return null;

  const variance = trades.reduce((s, t) => s + Math.pow(t.roi - avgRoi, 2), 0) / trades.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? avgRoi / stdDev : 0;

  const compositeScore =
    Math.min(winRate * 100, 100) * 0.25 +
    Math.min(Math.max(avgRoi * 50, 0), 100) * 0.25 +
    Math.min(Math.max(pnl30d / 1000, 0), 100) * 0.20 +
    Math.min(Math.max(sharpe * 20, 0), 100) * 0.15 +
    Math.min((recent7.length / 5) * 100, 100) * 0.15;

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

// ─── AGGIORNA HELIUS WEBHOOK ──────────────────────────────────────────────────
async function updateHeliusWebhook(walletAddresses: string[]) {
  if (!HELIUS_WEBHOOK_ID || walletAddresses.length === 0) {
    console.log("[Helius] Skip aggiornamento webhook (nessun wallet)");
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
    console.error("[Helius] Webhook update fallito:", await res.text());
  } else {
    console.log(`[Helius] Webhook aggiornato con ${walletAddresses.length} wallet`);
  }
}

// ─── PERSISTI RISULTATI ───────────────────────────────────────────────────────
async function persistResults(topWallets: WalletScore[]) {
  const addresses = topWallets.map((w) => w.address);

  await redis.del("smm:top_wallets");
  if (addresses.length > 0) {
    await redis.sadd("smm:top_wallets", ...addresses);
  }
  await redis.set("smm:total_wallets", String(addresses.length));

  try {
    const { error } = await supabase
      .from("top_wallets")
      .upsert(topWallets, { onConflict: "address" });
    if (error) console.error("[Supabase] Upsert errore:", error.message);

    await supabase.from("scouting_runs").insert({
      wallet_count: topWallets.length,
      top_score: topWallets[0]?.composite_score,
      avg_score: Math.round(
        topWallets.reduce((s, w) => s + w.composite_score, 0) / (topWallets.length || 1)
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

  const candidates = await fetchCandidates();
  console.log(`[Scout] ${candidates.length} candidati da analizzare`);

  const results: WalletScore[] = [];
  const BATCH = 3;

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const scores = await Promise.all(batch.map(analyzeWallet));
    scores.filter((s): s is WalletScore => s !== null).forEach((s) => results.push(s));
    if (i % 15 === 0) {
      console.log(`[Scout] ${i}/${candidates.length} analizzati, validi: ${results.length}`);
    }
    await sleep(800);
  }

  results.sort((a, b) => b.composite_score - a.composite_score);
  const top = results.slice(0, TOP_N);

  console.log(`\n[Scout] TOP ${top.length} WALLET:`);
  top.forEach((w, i) => {
    console.log(`  ${i + 1}. ${w.address.slice(0, 8)}... score=${w.composite_score} winRate=${w.win_rate}% pnl30d=$${w.pnl_30d_usd}`);
  });

  await persistResults(top);
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
