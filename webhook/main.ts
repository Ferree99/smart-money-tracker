/**
 * SMART MONEY TRACKER — Deno Deploy Webhook Handler
 * ─────────────────────────────────────────────────
 * Deploy su: https://deno.com/deploy
 * Questo file è l'intero server. Deno Deploy lo esegue gratuitamente 24/7.
 *
 * Flusso:
 * 1. Helius chiama POST /webhook con ogni transazione dei wallet monitorati
 * 2. Questo handler verifica se è un acquisto di un top wallet
 * 3. Registra in Upstash Redis con TTL = finestra temporale
 * 4. Se N wallet hanno comprato lo stesso token → invia alert Telegram
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { Redis } from "https://esm.sh/@upstash/redis@1.28.4";

// ─── ENV VARS (impostati nella dashboard Deno Deploy) ────────────────────────
const HELIUS_WEBHOOK_SECRET = Deno.env.get("HELIUS_WEBHOOK_SECRET")!;
const UPSTASH_REDIS_REST_URL = Deno.env.get("UPSTASH_REDIS_REST_URL")!;
const UPSTASH_REDIS_REST_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;
const BIRDEYE_API_KEY = Deno.env.get("BIRDEYE_API_KEY") || "";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFLUENCE_THRESHOLD = parseInt(Deno.env.get("CONFLUENCE_THRESHOLD") || "3");
const TIME_WINDOW_MS = parseInt(Deno.env.get("TIME_WINDOW_MINUTES") || "20") * 60_000;
const MIN_LIQUIDITY_USD = parseInt(Deno.env.get("MIN_LIQUIDITY_USD") || "30000");
const MIN_MARKET_CAP_USD = parseInt(Deno.env.get("MIN_MARKET_CAP_USD") || "50000");
const MIN_TOKEN_AGE_HOURS = parseInt(Deno.env.get("MIN_TOKEN_AGE_HOURS") || "12");
const ALERT_COOLDOWN_SEC = 30 * 60; // 30 minuti tra alert dello stesso token

const STABLECOINS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
]);

// ─── REDIS CLIENT ─────────────────────────────────────────────────────────────
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// ─── REDIS KEY HELPERS ────────────────────────────────────────────────────────
const KEY_WALLETS = "smm:top_wallets";          // SET di indirizzi
const KEY_TOKEN = (t: string) => `smm:token:${t}`;    // JSON array acquisti
const KEY_COOLDOWN = (t: string) => `smm:cd:${t}`;    // Flag cooldown alert
const KEY_TOTAL = "smm:total_wallets";           // Count totale wallet monitorati

// ─── ROUTER ──────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const url = new URL(req.url);

  // Health check
  if (req.method === "GET" && url.pathname === "/") {
    return json({ status: "ok", service: "Smart Money Tracker", ts: Date.now() });
  }

  // Webhook da Helius
  if (req.method === "POST" && url.pathname === "/webhook") {
    return handleWebhook(req);
  }

  // Endpoint per aggiungere/aggiornare wallet (chiamato dallo scout)
  if (req.method === "POST" && url.pathname === "/wallets") {
    return handleWalletsUpdate(req);
  }

  // Lista wallet attivi (debug)
  if (req.method === "GET" && url.pathname === "/wallets") {
    return handleWalletsList();
  }

  return json({ error: "Not found" }, 404);
});

// ─── WEBHOOK HANDLER ─────────────────────────────────────────────────────────
async function handleWebhook(req: Request): Promise<Response> {
  // Verifica secret header Helius
  const secret = req.headers.get("authorization");
  if (HELIUS_WEBHOOK_SECRET && secret !== HELIUS_WEBHOOK_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: unknown[];
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Helius invia un array di transazioni
  const transactions = Array.isArray(body) ? body : [body];

  for (const tx of transactions) {
    try {
      await processTx(tx);
    } catch (e) {
      console.error("Error processing tx:", (e as Error).message);
    }
  }

  return json({ ok: true, processed: transactions.length });
}

// ─── PROCESS SINGLE TRANSACTION ──────────────────────────────────────────────
async function processTx(tx: Record<string, unknown>) {
  // Solo SWAP
  if (tx.type !== "SWAP") return;

  const feePayer = tx.feePayer as string;
  if (!feePayer) return;

  // Verifica che il wallet sia nella top list
  const isTop = await redis.sismember(KEY_WALLETS, feePayer);
  if (!isTop) return;

  // Estrai token comprato (output dello swap)
  const swapEvent = (tx.events as Record<string, unknown>)?.swap as Record<string, unknown>;
  if (!swapEvent) return;

  const tokenOutputs = swapEvent.tokenOutputs as Array<Record<string, unknown>>;
  if (!tokenOutputs?.length) return;

  const tokenOut = tokenOutputs[0];
  const tokenAddress = tokenOut.mint as string;
  if (!tokenAddress || STABLECOINS.has(tokenAddress)) return;

  // Calcola valore USD dell'acquisto
  const amount = (tokenOut.tokenAmount as number) || 0;
  const price = (tokenOut.tokenPriceUSD as number) || 0;
  const amountUsd = amount * price;

  const timestamp = ((tx.timestamp as number) * 1000) || Date.now();

  console.log(`[SWAP] ${feePayer.slice(0, 8)}... → ${tokenAddress.slice(0, 8)}... (${amountUsd > 0 ? `$${Math.round(amountUsd)}` : "unknown USD"})`);

  // Filtro token (solo se Birdeye key disponibile)
  if (BIRDEYE_API_KEY) {
    const passes = await filterToken(tokenAddress);
    if (!passes) {
      console.log(`[FILTER] ${tokenAddress.slice(0, 8)}... escluso`);
      return;
    }
  }

  // Registra acquisto in Redis
  await recordPurchase(tokenAddress, feePayer, amountUsd, timestamp);

  // Controlla confluenza
  await checkConfluence(tokenAddress);
}

// ─── TOKEN FILTER ─────────────────────────────────────────────────────────────
async function filterToken(tokenAddress: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://public-api.birdeye.so/defi/token_overview?address=${tokenAddress}`,
      {
        headers: { "X-API-KEY": BIRDEYE_API_KEY },
        signal: AbortSignal.timeout(4000),
      }
    );
    if (!res.ok) return true; // In caso di errore API, non bloccare

    const data = await res.json() as { data?: Record<string, unknown> };
    const token = data?.data;
    if (!token) return false;

    // Età del token
    const createdTime = token.createdTime as number;
    if (createdTime) {
      const ageHours = (Date.now() / 1000 - createdTime) / 3600;
      if (ageHours < MIN_TOKEN_AGE_HOURS) return false;
    }

    // Liquidità
    const liquidity = token.liquidity as number;
    if (liquidity !== undefined && liquidity < MIN_LIQUIDITY_USD) return false;

    // Market cap
    const marketCap = token.marketCap as number;
    if (marketCap !== undefined && marketCap < MIN_MARKET_CAP_USD) return false;

    // Mint authority attiva = potenziale rug
    if (token.mintable === true) return false;

    return true;
  } catch {
    return true; // Non bloccare su timeout/errore
  }
}

// ─── REDIS: RECORD PURCHASE ───────────────────────────────────────────────────
async function recordPurchase(
  tokenAddress: string,
  wallet: string,
  amountUsd: number,
  timestamp: number
) {
  const key = KEY_TOKEN(tokenAddress);
  const ttlSec = Math.ceil(TIME_WINDOW_MS / 1000);

  const raw = await redis.get<string>(key);
  const entries: Array<{ wallet: string; timestamp: number; amountUsd: number }> =
    raw ? (typeof raw === "string" ? JSON.parse(raw) : raw as typeof entries) : [];

  // Rimuovi voci fuori dalla finestra temporale
  const cutoff = Date.now() - TIME_WINDOW_MS;
  const fresh = entries.filter((e) => e.timestamp > cutoff);

  // Aggiungi solo se wallet non già presente nella finestra
  if (!fresh.find((e) => e.wallet === wallet)) {
    fresh.push({ wallet, timestamp, amountUsd });
    await redis.set(key, JSON.stringify(fresh), { ex: ttlSec });
  }
}

// ─── REDIS: CHECK CONFLUENCE ──────────────────────────────────────────────────
async function checkConfluence(tokenAddress: string) {
  const key = KEY_TOKEN(tokenAddress);
  const raw = await redis.get<string>(key);
  if (!raw) return;

  const entries: Array<{ wallet: string; timestamp: number; amountUsd: number }> =
    typeof raw === "string" ? JSON.parse(raw) : raw as typeof entries;

  // Wallet unici nella finestra
  const cutoff = Date.now() - TIME_WINDOW_MS;
  const unique = [
    ...new Map(
      entries
        .filter((e) => e.timestamp > cutoff)
        .map((e) => [e.wallet, e])
    ).values(),
  ];

  if (unique.length < CONFLUENCE_THRESHOLD) return;

  // Controlla cooldown
  const cdKey = KEY_COOLDOWN(tokenAddress);
  const onCooldown = await redis.get(cdKey);
  if (onCooldown) return;

  // Imposta cooldown
  await redis.set(cdKey, "1", { ex: ALERT_COOLDOWN_SEC });

  // Calcola tempo confluenza
  const timestamps = unique.map((e) => e.timestamp);
  const confluenceMin = Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 60_000);

  // Wallet totali monitorati
  const totalWallets = parseInt((await redis.get<string>(KEY_TOTAL)) || "20");

  // Metadata token
  const meta = await getTokenMeta(tokenAddress);

  console.log(`[ALERT!] Confluenza ${unique.length}/${totalWallets} su ${tokenAddress}`);

  // Invia Telegram
  await sendTelegramAlert({
    tokenAddress,
    tokenSymbol: meta?.symbol || "???",
    tokenName: meta?.name || `${tokenAddress.slice(0, 8)}...`,
    wallets: unique,
    totalWallets,
    confluenceMin,
    priceUsd: meta?.price,
    marketCap: meta?.marketCap,
    liquidity: meta?.liquidity,
  });
}

// ─── TOKEN METADATA ───────────────────────────────────────────────────────────
interface TokenMeta {
  symbol: string;
  name: string;
  price?: number;
  marketCap?: number;
  liquidity?: number;
}

async function getTokenMeta(tokenAddress: string): Promise<TokenMeta | null> {
  if (!BIRDEYE_API_KEY) return null;
  try {
    const res = await fetch(
      `https://public-api.birdeye.so/defi/token_overview?address=${tokenAddress}`,
      {
        headers: { "X-API-KEY": BIRDEYE_API_KEY },
        signal: AbortSignal.timeout(4000),
      }
    );
    const data = await res.json() as { data?: Record<string, unknown> };
    const d = data?.data;
    if (!d) return null;
    return {
      symbol: (d.symbol as string) || "???",
      name: (d.name as string) || "Unknown",
      price: d.price as number,
      marketCap: d.marketCap as number,
      liquidity: d.liquidity as number,
    };
  } catch {
    return null;
  }
}

// ─── TELEGRAM ALERT ───────────────────────────────────────────────────────────
async function sendTelegramAlert(params: {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  wallets: Array<{ wallet: string; amountUsd: number }>;
  totalWallets: number;
  confluenceMin: number;
  priceUsd?: number;
  marketCap?: number;
  liquidity?: number;
}) {
  const {
    tokenAddress, tokenSymbol, tokenName,
    wallets, totalWallets, confluenceMin,
    priceUsd, marketCap, liquidity,
  } = params;

  const walletLines = wallets
    .map((w) => {
      const usd = w.amountUsd > 0 ? ` _(${fmtUsd(w.amountUsd)})_` : "";
      return `• \`${w.wallet.slice(0, 6)}...${w.wallet.slice(-4)}\`${usd}`;
    })
    .join("\n");

  const statsLines = [
    priceUsd ? `💵 Prezzo: $${priceUsd < 0.001 ? priceUsd.toExponential(2) : priceUsd.toFixed(6)}` : null,
    marketCap ? `📊 MCap: ${fmtUsd(marketCap)}` : null,
    liquidity ? `💧 Liquidità: ${fmtUsd(liquidity)}` : null,
  ].filter(Boolean).join("  |  ");

  const text = [
    `🚨 *SMART MONEY CONFLUENCE* 🚨`,
    ``,
    `*${tokenName}* \\— $${escMd(tokenSymbol)}`,
    statsLines ? statsLines : "",
    ``,
    `📋 *Contract:*`,
    `\`${tokenAddress}\``,
    ``,
    `👛 *Wallet concordanti:* ${wallets.length}/${totalWallets}`,
    walletLines,
    ``,
    `⏱ *Tempo confluenza:* ${confluenceMin === 0 ? "<1" : confluenceMin} min`,
    ``,
    `🔗 [DexScreener](https://dexscreener.com/solana/${tokenAddress}) · [BullX](https://bullx.io/terminal?chainId=1399811149&address=${tokenAddress}) · [Photon](https://photon-sol.tinyastro.io/en/r/@cMain/${tokenAddress}) · [GMGN](https://gmgn.ai/sol/token/${tokenAddress})`,
  ].filter((l) => l !== null).join("\n");

  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    }
  );
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

// Escape caratteri speciali MarkdownV2
function escMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

// ─── WALLET UPDATE ENDPOINT ───────────────────────────────────────────────────
async function handleWalletsUpdate(req: Request): Promise<Response> {
  const secret = req.headers.get("authorization");
  if (HELIUS_WEBHOOK_SECRET && secret !== HELIUS_WEBHOOK_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await req.json() as { wallets: string[] };
  const wallets: string[] = body.wallets || [];

  if (!wallets.length) return json({ error: "No wallets provided" }, 400);

  // Sostituisci tutto il set
  await redis.del(KEY_WALLETS);
  await redis.sadd(KEY_WALLETS, ...wallets);
  await redis.set(KEY_TOTAL, String(wallets.length));

  console.log(`[Wallets] Aggiornati: ${wallets.length} wallet`);
  return json({ ok: true, count: wallets.length });
}

async function handleWalletsList(): Promise<Response> {
  const wallets = await redis.smembers(KEY_WALLETS);
  return json({ count: wallets.length, wallets });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
