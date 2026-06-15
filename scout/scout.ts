/**
 * SMART MONEY TRACKER — Scout v5
 * 
 * Logica corretta:
 * 1. Trova token nuovi lanciati su Pump.fun nelle ultime 48h
 * 2. Per ogni token che ha fatto +200% dal lancio (pump confermato)
 * 3. Identifica chi ha comprato NEI PRIMI 10 MINUTI dal lancio
 * 4. Questi sono gli Smart Money — li salva e monitora
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

// Parametri scout
const MIN_PUMP_MULTIPLIER = 3.0;   // token deve aver fatto almeno 3x dal lancio
const EARLY_BUYER_WINDOW_MIN = 10; // compratori nei primi 10 minuti = smart money
const LOOKBACK_HOURS = 48;         // analizza token degli ultimi 48h

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SOL_MINT = "So11111111111111111111111111111111111111112";
let solPriceUsd = 150;

// ─── PREZZO SOL ───────────────────────────────────────────────────────────────
async function fetchSolPrice() {
  try {
    const res = await fetch(
      "https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112",
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json() as { data?: Record<string, { price?: number }> };
    const price = data?.data?.[SOL_MINT]?.price;
    if (price && price > 0) { solPriceUsd = price; }
    console.log(`[Price] SOL = $${solPriceUsd}`);
  } catch { console.warn("[Price] Usando fallback SOL:", solPriceUsd); }
}

// ─── STEP 1: TROVA TOKEN CON PUMP CONFERMATO ─────────────────────────────────
interface PumpToken {
  mint: string;
  launchTimestamp: number;  // quando è stato lanciato
  peakMultiplier: number;   // quanto ha pompato
}

async function findPumpedTokens(): Promise<PumpToken[]> {
  const pumped: PumpToken[] = [];

  // Fonte A: DexScreener - token Solana nuovi con grande variazione
  try {
    const res = await fetch(
      "https://api.dexscreener.com/token-profiles/latest/v1",
      { signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const data = await res.json() as Array<{ chainId?: string; tokenAddress?: string }>;
      const solTokens = data.filter((t) => t.chainId === "solana").slice(0, 30);
      console.log(`[DexScreener] ${solTokens.length} token nuovi trovati`);

      for (const token of solTokens) {
        if (!token.tokenAddress) continue;
        const pumpData = await checkTokenPump(token.tokenAddress);
        if (pumpData) pumped.push(pumpData);
        await sleep(300);
      }
    }
  } catch (e) {
    console.warn("[DexScreener] Fallito:", (e as Error).message);
  }

  // Fonte B: DexScreener boosted tokens (token che stanno pompando ORA)
  try {
    const res = await fetch(
      "https://api.dexscreener.com/token-boosts/top/v1",
      { signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const data = await res.json() as Array<{ chainId?: string; tokenAddress?: string }>;
      const solTokens = data.filter((t) => t.chainId === "solana").slice(0, 20);
      console.log(`[DexScreener Boost] ${solTokens.length} token in evidenza`);

      for (const token of solTokens) {
        if (!token.tokenAddress) continue;
        const alreadyFound = pumped.find((p) => p.mint === token.tokenAddress);
        if (alreadyFound) continue;
        const pumpData = await checkTokenPump(token.tokenAddress);
        if (pumpData) pumped.push(pumpData);
        await sleep(300);
      }
    }
  } catch (e) {
    console.warn("[DexScreener Boost] Fallito:", (e as Error).message);
  }

  // Fonte C: cerca nelle tx recenti di Pump.fun i token lanciati di recente
  try {
    const pumpfunTokens = await fetchRecentPumpfunLaunches();
    console.log(`[Pump.fun] ${pumpfunTokens.length} lanci recenti`);
    for (const mint of pumpfunTokens) {
      const alreadyFound = pumped.find((p) => p.mint === mint);
      if (alreadyFound) continue;
      const pumpData = await checkTokenPump(mint);
      if (pumpData) pumped.push(pumpData);
      await sleep(300);
    }
  } catch (e) {
    console.warn("[Pump.fun] Fallito:", (e as Error).message);
  }

  console.log(`[Scout] ${pumped.length} token con pump confermato (>${MIN_PUMP_MULTIPLIER}x)`);
  return pumped;
}

// Controlla se un token ha pompato abbastanza
async function checkTokenPump(mint: string): Promise<PumpToken | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as { pairs?: Array<Record<string, unknown>> };
    const pair = data?.pairs?.[0];
    if (!pair) return null;

    // Variazione prezzo nelle ultime 24h
    const priceChange24h = (pair.priceChange as Record<string, number>)?.h24 || 0;
    const priceChange6h = (pair.priceChange as Record<string, number>)?.h6 || 0;

    // Considera "pump" se ha fatto +200% in 24h o +100% in 6h
    const hasPumped = priceChange24h >= 200 || priceChange6h >= 100;
    if (!hasPumped) return null;

    // Stima moltiplicatore
    const multiplier = Math.max(
      1 + priceChange24h / 100,
      1 + priceChange6h / 100
    );

    if (multiplier < MIN_PUMP_MULTIPLIER) return null;

    // Timestamp di creazione della pair (approssimazione del lancio)
    const pairCreatedAt = (pair.pairCreatedAt as number) || 0;
    const launchTimestamp = pairCreatedAt || (Date.now() - 24 * 3600000);

    // Solo token lanciati nelle ultime LOOKBACK_HOURS
    const ageHours = (Date.now() - launchTimestamp) / 3600000;
    if (ageHours > LOOKBACK_HOURS) return null;

    console.log(`  ✓ ${mint.slice(0, 8)}... +${Math.round(priceChange24h)}% (${multiplier.toFixed(1)}x) età ${ageHours.toFixed(1)}h`);

    return {
      mint,
      launchTimestamp,
      peakMultiplier: multiplier,
    };
  } catch {
    return null;
  }
}

// Trova lanci recenti su Pump.fun tramite Helius
async function fetchRecentPumpfunLaunches(): Promise<string[]> {
  const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  try {
    const url = `https://api.helius.xyz/v0/addresses/${PUMP_FUN_PROGRAM}/transactions?api-key=${HELIUS_API_KEY}&limit=100`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const txs = await res.json() as Array<Record<string, unknown>>;

    const mints = new Set<string>();
    const cutoff = Date.now() - LOOKBACK_HOURS * 3600000;

    for (const tx of txs) {
      const timestamp = (tx.timestamp as number) * 1000;
      if (timestamp < cutoff) continue;

      // Estrai mint dalle tokenTransfers
      const transfers = (tx.tokenTransfers as Array<{ mint?: string }>) || [];
      for (const t of transfers) {
        if (t.mint && t.mint !== SOL_MINT && t.mint.length > 30) {
          mints.add(t.mint);
        }
      }
    }
    return Array.from(mints).slice(0, 50);
  } catch {
    return [];
  }
}

// ─── STEP 2: TROVA EARLY BUYERS DI UN TOKEN ──────────────────────────────────
async function findEarlyBuyers(token: PumpToken): Promise<string[]> {
  const earlyBuyers = new Set<string>();
  const windowMs = EARLY_BUYER_WINDOW_MIN * 60 * 1000;
  const cutoffTimestamp = token.launchTimestamp + windowMs;

  try {
    // Prendi le prime transazioni del token dopo il lancio
    const url = `https://api.helius.xyz/v0/addresses/${token.mint}/transactions?api-key=${HELIUS_API_KEY}&type=SWAP&limit=100`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];

    const txs = await res.json() as Array<Record<string, unknown>>;

    // Ordina per timestamp crescente (prima transazione = lancio)
    txs.sort((a, b) => (a.timestamp as number) - (b.timestamp as number));

    for (const tx of txs) {
      const txTimestamp = (tx.timestamp as number) * 1000;

      // Solo transazioni nei primi N minuti dal lancio
      if (txTimestamp > cutoffTimestamp) continue;

      const feePayer = tx.feePayer as string;
      if (!feePayer || feePayer.length < 30) continue;

      // Verifica che abbia effettivamente COMPRATO (ricevuto il token)
      const transfers = (tx.tokenTransfers as Array<{
        toUserAccount?: string;
        mint?: string;
        tokenAmount?: number;
      }>) || [];

      const boughtToken = transfers.some(
        (t) => t.toUserAccount === feePayer &&
               t.mint === token.mint &&
               (t.tokenAmount || 0) > 0
      );

      if (boughtToken) {
        earlyBuyers.add(feePayer);
      }
    }
  } catch (e) {
    console.warn(`[EarlyBuyers] ${token.mint.slice(0, 8)}:`, (e as Error).message);
  }

  return Array.from(earlyBuyers);
}

// ─── STEP 3: VALUTA UN WALLET (quante volte è stato early buyer di successo) ──
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
  // Raccogliamo le tx del wallet per avere statistiche complete
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

        const sent = transfers.find((t) => t.fromUserAccount === address && t.mint === SOL_MINT);
        const received = transfers.find((t) => t.toUserAccount === address && t.mint === SOL_MINT);

        const inputUsd = sent ? sent.tokenAmount! * solPriceUsd : 0;
        const outputUsd = received ? received.tokenAmount! * solPriceUsd : 0;
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
  } catch { /* usa solo i dati che abbiamo */ }

  const recent30 = trades.filter((t) => t.daysAgo <= 30);
  const recent7 = trades.filter((t) => t.daysAgo <= 7);
  const pnl30d = recent30.reduce((s, t) => s + t.pnlUsd, 0);
  const pnl7d = recent7.reduce((s, t) => s + t.pnlUsd, 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const totalInvested = trades.reduce((s, t) => s + t.inputUsd, 0);
  const winRate = trades.length > 0
    ? trades.filter((t) => t.pnlUsd > 0).length / trades.length
    : successfulCalls / Math.max(totalTokens, 1);

  // Score basato principalmente su: quante volte è stato early buyer di successo
  const earlyBuyerScore = Math.min((successfulCalls / Math.max(totalTokens, 1)) * 100, 100);
  const pnlScore = Math.min(Math.max(pnl30d / 500, 0), 100);
  const winScore = winRate * 100;
  const activityScore = Math.min((recent7.length / 5) * 100, 100);

  const compositeScore =
    earlyBuyerScore * 0.40 +  // peso maggiore: capacità di anticipare
    winScore * 0.25 +
    pnlScore * 0.20 +
    activityScore * 0.15;

  return {
    address,
    composite_score: Math.round(compositeScore * 10) / 10,
    total_pnl_usd: Math.round(totalPnl),
    pnl_30d_usd: Math.round(pnl30d),
    pnl_7d_usd: Math.round(pnl7d),
    avg_roi: trades.length > 0
      ? Math.round((trades.reduce((s, t) => s + t.pnlUsd / t.inputUsd, 0) / trades.length) * 10000) / 100
      : 0,
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
  } catch (e) {
    console.warn("[Supabase] Errore:", (e as Error).message);
  }
  console.log(`[DB] ${addresses.length} wallet salvati`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Smart Money Scout v5 ===", new Date().toISOString());
  console.log(`Logica: trova chi compra PRIMA del pump sui nuovi token`);

  await fetchSolPrice();

  // Step 1: trova token che hanno pompato
  console.log("\n[Step 1] Cerco token con pump confermato...");
  const pumpedTokens = await findPumpedTokens();

  if (pumpedTokens.length === 0) {
    console.warn("[Scout] Nessun token con pump trovato. Riprova tra qualche ora.");
    return;
  }

  // Step 2: per ogni token, trova chi ha comprato prima del pump
  console.log(`\n[Step 2] Analizzo early buyers di ${pumpedTokens.length} token...`);
  const walletSuccesses = new Map<string, number>(); // wallet -> numero di call vincenti

  for (const token of pumpedTokens) {
    const earlyBuyers = await findEarlyBuyers(token);
    console.log(`  ${token.mint.slice(0, 8)}... (${token.peakMultiplier.toFixed(1)}x): ${earlyBuyers.length} early buyers`);

    for (const buyer of earlyBuyers) {
      walletSuccesses.set(buyer, (walletSuccesses.get(buyer) || 0) + 1);
    }
    await sleep(400);
  }

  console.log(`\n[Step 2] ${walletSuccesses.size} wallet unici trovati come early buyers`);

  // Step 3: score e ranking
  console.log("\n[Step 3] Calcolo score...");
  const scores: WalletScore[] = [];

  const candidates = Array.from(walletSuccesses.entries())
    .sort((a, b) => b[1] - a[1]) // ordina per numero di call vincenti
    .slice(0, 60); // top 60 candidati da analizzare

  for (let i = 0; i < candidates.length; i += 3) {
    const batch = candidates.slice(i, i + 3);
    const batchScores = await Promise.all(
      batch.map(([addr, successes]) => scoreWallet(addr, successes, pumpedTokens.length))
    );
    batchScores.forEach((s) => scores.push(s));
    if (i % 15 === 0) console.log(`  ${i}/${candidates.length} scorati`);
    await sleep(600);
  }

  scores.sort((a, b) => b.composite_score - a.composite_score);
  const top = scores.slice(0, TOP_N);

  console.log(`\n[Scout] TOP ${top.length} SMART MONEY WALLET:`);
  top.forEach((w, i) => {
    console.log(`  ${i + 1}. ${w.address.slice(0, 8)}... score=${w.composite_score} win=${w.win_rate}% pnl30d=$${w.pnl_30d_usd}`);
  });

  if (top.length === 0) {
    console.warn("[Scout] Nessun wallet qualificato trovato.");
    return;
  }

  await persistResults(top);
  await updateHeliusWebhook(top.map((w) => w.address));
  console.log("\n[Scout] Completato con successo.");
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error("[FATAL]", e); Deno.exit(1); });
