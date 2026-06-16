/**
 * SMART MONEY TRACKER — Scout v6
 * Fix: launchTimestamp dalla prima tx reale, finestra allargata, più token
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
const TOP_N = parseInt(Deno.env.get("TOP_WALLET_COUNT") || "50");

const MIN_PUMP_MULTIPLIER = 3.0;
const EARLY_BUYER_WINDOW_MIN = 30; // allargato a 30 min per catturare più early buyers
const LOOKBACK_HOURS = 48;

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const STABLES = new Set([USDC_MINT, USDT_MINT]);
let solPriceUsd = 150;

async function fetchSolPrice() {
  try {
    const res = await fetch(
      "https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112",
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json() as { data?: Record<string, { price?: number }> };
    const price = data?.data?.[SOL_MINT]?.price;
    if (price && price > 0) solPriceUsd = price;
    console.log(`[Price] SOL = $${solPriceUsd}`);
  } catch { console.warn("[Price] Fallback SOL:", solPriceUsd); }
}

// ─── STEP 1: TROVA TOKEN POMPATI ─────────────────────────────────────────────
interface PumpToken {
  mint: string;
  launchTimestamp: number;
  peakMultiplier: number;
  name: string;
}

async function findPumpedTokens(): Promise<PumpToken[]> {
  const pumped: PumpToken[] = [];
  const seen = new Set<string>();

  // Fonte A: token nuovi su DexScreener
  try {
    const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1",
      { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json() as Array<{ chainId?: string; tokenAddress?: string }>;
      const solTokens = data.filter((t) => t.chainId === "solana").slice(0, 50);
      for (const t of solTokens) {
        if (!t.tokenAddress || seen.has(t.tokenAddress)) continue;
        seen.add(t.tokenAddress);
        const p = await checkTokenPump(t.tokenAddress);
        if (p) pumped.push(p);
        await sleep(250);
      }
      console.log(`[DexScreener New] ${pumped.length} con pump`);
    }
  } catch (e) { console.warn("[DexScreener]", (e as Error).message); }

  // Fonte B: token boosted (stanno pompando ora)
  try {
    const res = await fetch("https://api.dexscreener.com/token-boosts/top/v1",
      { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json() as Array<{ chainId?: string; tokenAddress?: string }>;
      const solTokens = data.filter((t) => t.chainId === "solana").slice(0, 30);
      for (const t of solTokens) {
        if (!t.tokenAddress || seen.has(t.tokenAddress)) continue;
        seen.add(t.tokenAddress);
        const p = await checkTokenPump(t.tokenAddress);
        if (p) pumped.push(p);
        await sleep(250);
      }
      console.log(`[DexScreener Boost] totale ${pumped.length} con pump`);
    }
  } catch (e) { console.warn("[DexScreener Boost]", (e as Error).message); }

  // Fonte C: Pump.fun lanci recenti
  try {
    const mints = await fetchRecentPumpfunLaunches();
    for (const mint of mints) {
      if (seen.has(mint)) continue;
      seen.add(mint);
      const p = await checkTokenPump(mint);
      if (p) pumped.push(p);
      await sleep(250);
    }
    console.log(`[Pump.fun] totale ${pumped.length} con pump`);
  } catch (e) { console.warn("[Pump.fun]", (e as Error).message); }

  console.log(`\n[Step 1] ${pumped.length} token con pump >${MIN_PUMP_MULTIPLIER}x trovati`);
  return pumped;
}

async function checkTokenPump(mint: string): Promise<PumpToken | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json() as { pairs?: Array<Record<string, unknown>> };
    // Prendi la pair con più liquidità
    const pairs = (data?.pairs || []).filter((p) => (p.chainId as string) === "solana");
    if (!pairs.length) return null;
    const pair = pairs.sort((a, b) => ((b.liquidity as Record<string,number>)?.usd || 0) - ((a.liquidity as Record<string,number>)?.usd || 0))[0];

    const priceChange24h = (pair.priceChange as Record<string, number>)?.h24 || 0;
    const priceChange6h = (pair.priceChange as Record<string, number>)?.h6 || 0;
    const priceChange1h = (pair.priceChange as Record<string, number>)?.h1 || 0;

    const maxChange = Math.max(priceChange24h, priceChange6h, priceChange1h);
    if (maxChange < (MIN_PUMP_MULTIPLIER - 1) * 100) return null;

    const multiplier = 1 + maxChange / 100;
    const pairCreatedAt = (pair.pairCreatedAt as number) || Date.now();
    const ageHours = (Date.now() - pairCreatedAt) / 3600000;
    if (ageHours > LOOKBACK_HOURS) return null;

    const name = (pair.baseToken as Record<string,string>)?.symbol || mint.slice(0, 8);
    return { mint, launchTimestamp: pairCreatedAt, peakMultiplier: multiplier, name };
  } catch { return null; }
}

async function fetchRecentPumpfunLaunches(): Promise<string[]> {
  const PUMP_FUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${PUMP_FUN}/transactions?api-key=${HELIUS_API_KEY}&limit=100`,
      { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const txs = await res.json() as Array<Record<string, unknown>>;
    const mints = new Set<string>();
    const cutoff = Date.now() - LOOKBACK_HOURS * 3600000;
    for (const tx of txs) {
      if ((tx.timestamp as number) * 1000 < cutoff) continue;
      const transfers = (tx.tokenTransfers as Array<{ mint?: string }>) || [];
      for (const t of transfers) {
        if (t.mint && t.mint !== SOL_MINT && t.mint.length > 30) mints.add(t.mint);
      }
    }
    return Array.from(mints).slice(0, 50);
  } catch { return []; }
}

// ─── STEP 2: TROVA EARLY BUYERS ───────────────────────────────────────────────
async function findEarlyBuyers(token: PumpToken): Promise<string[]> {
  const earlyBuyers = new Set<string>();

  try {
    // Prendi le tx del token ordinate cronologicamente (dalla più vecchia)
    const url = `https://api.helius.xyz/v0/addresses/${token.mint}/transactions?api-key=${HELIUS_API_KEY}&type=SWAP&limit=100`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];

    const txs = await res.json() as Array<Record<string, unknown>>;
    if (!txs.length) return [];

    // Ordina dalla più vecchia alla più recente
    txs.sort((a, b) => (a.timestamp as number) - (b.timestamp as number));

    // Il vero lancio = timestamp della prima transazione trovata
    const firstTxTimestamp = (txs[0].timestamp as number) * 1000;
    const windowMs = EARLY_BUYER_WINDOW_MIN * 60 * 1000;
    const cutoff = firstTxTimestamp + windowMs;

    console.log(`    Lancio reale: ${new Date(firstTxTimestamp).toISOString()}, finestra: ${EARLY_BUYER_WINDOW_MIN}min`);

    for (const tx of txs) {
      const txTs = (tx.timestamp as number) * 1000;
      if (txTs > cutoff) break; // fuori finestra, stop

      const feePayer = tx.feePayer as string;
      if (!feePayer || feePayer.length < 30) continue;

      const transfers = (tx.tokenTransfers as Array<{
        toUserAccount?: string;
        fromUserAccount?: string;
        mint?: string;
        tokenAmount?: number;
      }>) || [];

      // Ha ricevuto il token? → è un acquirente
      const bought = transfers.some(
        (t) => t.toUserAccount === feePayer &&
               t.mint === token.mint &&
               (t.tokenAmount || 0) > 0
      );

      // Oppure: ha mandato SOL → è sicuramente un acquisto
      const sentSol = transfers.some(
        (t) => t.fromUserAccount === feePayer && t.mint === SOL_MINT
      );

      if (bought || sentSol) earlyBuyers.add(feePayer);
    }
  } catch (e) {
    console.warn(`    Errore: ${(e as Error).message}`);
  }

  return Array.from(earlyBuyers);
}

// ─── STEP 3: SCORE WALLET ─────────────────────────────────────────────────────
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

async function scoreWallet(address: string, successfulCalls: number, totalTokens: number): Promise<WalletScore> {
  let trades: Array<{ inputUsd: number; pnlUsd: number; timestamp: number; daysAgo: number }> = [];

  try {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&type=SWAP&limit=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const txs = await res.json() as Array<Record<string, unknown>>;
      for (const tx of txs) {
        const transfers = (tx.tokenTransfers as Array<{
          fromUserAccount?: string;
          toUserAccount?: string;
          mint?: string;
          tokenAmount?: number;
        }>) || [];

        // Calcola SOL speso e SOL ricevuto
        const solSent = transfers
          .filter((t) => t.fromUserAccount === address && t.mint === SOL_MINT)
          .reduce((s, t) => s + (t.tokenAmount || 0), 0);
        const solReceived = transfers
          .filter((t) => t.toUserAccount === address && t.mint === SOL_MINT)
          .reduce((s, t) => s + (t.tokenAmount || 0), 0);

        // Anche stabili
        const stableSent = transfers
          .filter((t) => t.fromUserAccount === address && STABLES.has(t.mint || ""))
          .reduce((s, t) => s + (t.tokenAmount || 0), 0);
        const stableReceived = transfers
          .filter((t) => t.toUserAccount === address && STABLES.has(t.mint || ""))
          .reduce((s, t) => s + (t.tokenAmount || 0), 0);

        const inputUsd = solSent * solPriceUsd + stableSent;
        const outputUsd = solReceived * solPriceUsd + stableReceived;

        if (inputUsd < 1) continue;

        const timestamp = (tx.timestamp as number) * 1000;
        trades.push({
          inputUsd,
          pnlUsd: outputUsd - inputUsd,
          timestamp,
          daysAgo: (Date.now() - timestamp) / 86_400_000,
        });
      }
    }
  } catch { /* usa solo early buyer score */ }

  const recent30 = trades.filter((t) => t.daysAgo <= 30);
  const recent7 = trades.filter((t) => t.daysAgo <= 7);
  const pnl30d = recent30.reduce((s, t) => s + t.pnlUsd, 0);
  const pnl7d = recent7.reduce((s, t) => s + t.pnlUsd, 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const totalInvested = trades.reduce((s, t) => s + t.inputUsd, 0);

  // Win rate: considera vincente un trade in cui ha ricevuto più SOL di quanto ne ha mandato
  const winningTrades = trades.filter((t) => t.pnlUsd > 0);
  const winRate = trades.length > 0 ? winningTrades.length / trades.length : 0;

  // Early buyer accuracy: metrica principale
  const earlyAccuracy = successfulCalls / Math.max(totalTokens, 1);

  // Score composito — 40% early buyer accuracy, resto performance
  const compositeScore =
    Math.min(earlyAccuracy * 100, 100) * 0.40 +
    Math.min(winRate * 100, 100) * 0.25 +
    Math.min(Math.max(pnl30d / 300, 0), 100) * 0.20 +
    Math.min((recent7.length / 3) * 100, 100) * 0.15;

  return {
    address,
    composite_score: Math.round(compositeScore * 10) / 10,
    total_pnl_usd: Math.round(totalPnl),
    pnl_30d_usd: Math.round(pnl30d),
    pnl_7d_usd: Math.round(pnl7d),
    avg_roi: trades.length > 0
      ? Math.round((trades.reduce((s, t) => s + t.pnlUsd / Math.max(t.inputUsd, 1), 0) / trades.length) * 10000) / 100
      : Math.round(earlyAccuracy * 10000) / 100,
    win_rate: Math.round(winRate * 10000) / 100,
    trade_count: trades.length,
    trade_count_30d: recent30.length,
    sharpe_ratio: 0,
    avg_trade_size_usd: trades.length > 0 ? Math.round(totalInvested / trades.length) : 0,
    last_active_at: trades.length > 0
      ? new Date(Math.max(...trades.map((t) => t.timestamp))).toISOString()
      : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
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

// ─── PERSISTI ─────────────────────────────────────────────────────────────────
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
  } catch (e) { console.warn("[Supabase]", (e as Error).message); }
  console.log(`[DB] ${addresses.length} wallet salvati`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Smart Money Scout v6 ===", new Date().toISOString());
  await fetchSolPrice();

  // Step 1
  console.log("\n[Step 1] Cerco token con pump confermato...");
  const pumpedTokens = await findPumpedTokens();
  if (!pumpedTokens.length) {
    console.warn("[Scout] Nessun token pompato trovato. Riprova tra qualche ora.");
    return;
  }

  // Step 2
  console.log(`\n[Step 2] Analizzo early buyers (finestra ${EARLY_BUYER_WINDOW_MIN} min)...`);
  const walletSuccesses = new Map<string, number>();

  for (const token of pumpedTokens) {
    console.log(`  ${token.name} (${token.mint.slice(0, 8)}...) ${token.peakMultiplier.toFixed(1)}x:`);
    const buyers = await findEarlyBuyers(token);
    console.log(`    → ${buyers.length} early buyers`);
    for (const b of buyers) walletSuccesses.set(b, (walletSuccesses.get(b) || 0) + 1);
    await sleep(400);
  }

  console.log(`\n[Step 2] ${walletSuccesses.size} wallet early buyers trovati`);

  if (!walletSuccesses.size) {
    console.warn("[Scout] Nessun early buyer trovato. I token potrebbero essere troppo recenti.");
    return;
  }

  // Step 3
  console.log("\n[Step 3] Score e ranking...");
  const candidates = Array.from(walletSuccesses.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60);

  const scores: WalletScore[] = [];
  for (let i = 0; i < candidates.length; i += 3) {
    const batch = candidates.slice(i, i + 3);
    const batchScores = await Promise.all(
      batch.map(([addr, s]) => scoreWallet(addr, s, pumpedTokens.length))
    );
    batchScores.forEach((s) => scores.push(s));
    await sleep(500);
  }

  scores.sort((a, b) => b.composite_score - a.composite_score);
  // Filtra wallet senza history reale (almeno 2 trade storici)
  const qualified = scores.filter((w) => w.trade_count >= 2);
  const top = qualified.slice(0, TOP_N);
  console.log(`[Scout] ${scores.length} scorati, ${qualified.length} con storia sufficiente`);

  console.log(`\n[Scout] TOP ${top.length} SMART MONEY:`);
  top.forEach((w, i) => {
    console.log(`  ${i + 1}. ${w.address.slice(0, 8)}... score=${w.composite_score} win=${w.win_rate}% pnl30d=$${w.pnl_30d_usd} trades=${w.trade_count}`);
  });

  await persistResults(top);
  await updateHeliusWebhook(top.map((w) => w.address));
  console.log("\n[Scout] Completato.");
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
main().catch((e) => { console.error("[FATAL]", e); Deno.exit(1); });
