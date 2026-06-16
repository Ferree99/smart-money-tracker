/**
 * SMART MONEY TRACKER — Webhook Handler v2
 * Parser corretto: usa tokenTransfers (non events.swap)
 * Deploy su Deno Deploy — gira 24/7 gratis
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { Redis } from "https://esm.sh/@upstash/redis@1.28.4";

// ─── ENV ──────────────────────────────────────────────────────────────────────
const WEBHOOK_SECRET = Deno.env.get("HELIUS_WEBHOOK_SECRET") || "";
const UPSTASH_URL = Deno.env.get("UPSTASH_REDIS_REST_URL")!;
const UPSTASH_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!;
const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TG_CHAT = Deno.env.get("TELEGRAM_CHAT_ID")!;

const CONFLUENCE_THRESHOLD = parseInt(Deno.env.get("CONFLUENCE_THRESHOLD") || "3");
const TIME_WINDOW_MS = parseInt(Deno.env.get("TIME_WINDOW_MINUTES") || "20") * 60_000;
const ALERT_COOLDOWN_SEC = 30 * 60; // no spam: max 1 alert ogni 30 min per token

// Token da ignorare (non sono "nuovi token" interessanti)
const IGNORE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",   // SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  // USDT
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK (già noto)
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF (già noto)
]);

// ─── REDIS ────────────────────────────────────────────────────────────────────
const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

const K_WALLETS = "smm:top_wallets";
const K_TOTAL = "smm:total_wallets";
const K_TOKEN = (t: string) => `smm:token:${t}`;
const K_CD = (t: string) => `smm:cd:${t}`;

// ─── SERVER ───────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/") {
    const count = await redis.scard(K_WALLETS).catch(() => 0);
    return json({ status: "ok", monitored_wallets: count, ts: Date.now() });
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    return handleWebhook(req);
  }

  if (req.method === "POST" && url.pathname === "/wallets") {
    return handleWalletsUpdate(req);
  }

  if (req.method === "GET" && url.pathname === "/wallets") {
    const wallets = await redis.smembers(K_WALLETS);
    return json({ count: wallets.length, wallets });
  }

  return json({ error: "Not found" }, 404);
});

// ─── WEBHOOK HANDLER ─────────────────────────────────────────────────────────
async function handleWebhook(req: Request): Promise<Response> {
  if (WEBHOOK_SECRET) {
    const auth = req.headers.get("authorization") || req.headers.get("authHeader") || "";
    if (auth !== WEBHOOK_SECRET) return json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }

  const transactions = Array.isArray(body) ? body : [body];
  let processed = 0;

  for (const tx of transactions) {
    try {
      await processTx(tx as Record<string, unknown>);
      processed++;
    } catch (e) {
      console.error("[TX Error]", (e as Error).message);
    }
  }

  return json({ ok: true, processed });
}

// ─── PROCESSA SINGOLA TX ──────────────────────────────────────────────────────
async function processTx(tx: Record<string, unknown>) {
  if (tx.type !== "SWAP") return;

  const feePayer = tx.feePayer as string;
  if (!feePayer) return;

  // Verifica che il wallet sia nella top list
  const isTop = await redis.sismember(K_WALLETS, feePayer);
  if (!isTop) return;

  // Estrai token COMPRATO dal wallet usando tokenTransfers
  const transfers = (tx.tokenTransfers as Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    mint?: string;
    tokenAmount?: number;
  }>) || [];

  // Token ricevuto dal feePayer (quello che ha comprato)
  const received = transfers.filter(
    (t) => t.toUserAccount === feePayer &&
           t.mint &&
           !IGNORE_MINTS.has(t.mint) &&
           (t.tokenAmount || 0) > 0
  );

  if (!received.length) return;

  // Prendi il token principale ricevuto (quello con più valore)
  const tokenMint = received[received.length - 1].mint!;

  // Calcola SOL speso come proxy del valore dell'acquisto
  const solSent = transfers
    .filter((t) => t.fromUserAccount === feePayer && t.mint === "So11111111111111111111111111111111111111112")
    .reduce((s, t) => s + (t.tokenAmount || 0), 0);

  const amountSol = solSent;
  const timestamp = ((tx.timestamp as number) * 1000) || Date.now();

  console.log(`[SWAP] ${feePayer.slice(0, 8)}... → ${tokenMint.slice(0, 8)}... (${amountSol.toFixed(3)} SOL)`);

  // Registra in Redis e controlla confluenza
  await recordAndCheck(tokenMint, feePayer, amountSol, timestamp);
}

// ─── REDIS: RECORD + CHECK CONFLUENZA ────────────────────────────────────────
interface Purchase {
  wallet: string;
  timestamp: number;
  amountSol: number;
}

async function recordAndCheck(mint: string, wallet: string, amountSol: number, timestamp: number) {
  const key = K_TOKEN(mint);
  const ttlSec = Math.ceil(TIME_WINDOW_MS / 1000);

  // Leggi acquisti esistenti
  let purchases: Purchase[] = [];
  try {
    const raw = await redis.get<string>(key);
    if (raw) purchases = typeof raw === "string" ? JSON.parse(raw) : raw as Purchase[];
  } catch { purchases = []; }

  // Rimuovi voci fuori finestra temporale
  const cutoff = Date.now() - TIME_WINDOW_MS;
  purchases = purchases.filter((p) => p.timestamp > cutoff);

  // Aggiungi solo se wallet non già presente nella finestra
  if (!purchases.find((p) => p.wallet === wallet)) {
    purchases.push({ wallet, timestamp, amountSol });
    await redis.set(key, JSON.stringify(purchases), { ex: ttlSec });
  }

  // Controlla soglia confluenza
  if (purchases.length < CONFLUENCE_THRESHOLD) return;

  // Cooldown: evita alert ripetuti per lo stesso token
  const cdKey = K_CD(mint);
  const onCd = await redis.get(cdKey);
  if (onCd) return;
  await redis.set(cdKey, "1", { ex: ALERT_COOLDOWN_SEC });

  // Calcola tempo confluenza
  const timestamps = purchases.map((p) => p.timestamp);
  const confluenceMin = Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 60_000);

  // Fetch metadata token da DexScreener (gratis)
  const meta = await fetchTokenMeta(mint);

  // Wallet totali monitorati
  const totalWallets = parseInt((await redis.get<string>(K_TOTAL)) || "50");

  console.log(`[ALERT!] Confluenza ${purchases.length}/${totalWallets} su ${mint}`);

  await sendTelegramAlert({
    mint,
    symbol: meta?.symbol || "???",
    name: meta?.name || mint.slice(0, 8) + "...",
    purchases,
    totalWallets,
    confluenceMin,
    priceUsd: meta?.priceUsd,
    marketCap: meta?.marketCap,
    liquidity: meta?.liquidity,
    ageMin: meta?.ageMin,
  });

  // Salva alert su Supabase (fire and forget)
  logAlert(mint, meta?.symbol, purchases, confluenceMin).catch(() => {});
}

// ─── TOKEN METADATA DA DEXSCREENER ───────────────────────────────────────────
interface TokenMeta {
  symbol: string;
  name: string;
  priceUsd?: number;
  marketCap?: number;
  liquidity?: number;
  ageMin?: number;
}

async function fetchTokenMeta(mint: string): Promise<TokenMeta | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as { pairs?: Array<Record<string, unknown>> };
    const pairs = (data?.pairs || []).filter((p) => p.chainId === "solana");
    if (!pairs.length) return null;

    const pair = pairs.sort((a, b) =>
      ((b.liquidity as Record<string, number>)?.usd || 0) -
      ((a.liquidity as Record<string, number>)?.usd || 0)
    )[0];

    const base = pair.baseToken as Record<string, string>;
    const pairCreatedAt = pair.pairCreatedAt as number;
    const ageMin = pairCreatedAt ? Math.round((Date.now() - pairCreatedAt) / 60_000) : undefined;

    return {
      symbol: base?.symbol || "???",
      name: base?.name || "Unknown",
      priceUsd: parseFloat(pair.priceUsd as string) || undefined,
      marketCap: (pair.marketCap as number) || undefined,
      liquidity: (pair.liquidity as Record<string, number>)?.usd || undefined,
      ageMin,
    };
  } catch { return null; }
}

// ─── TELEGRAM ALERT ───────────────────────────────────────────────────────────
async function sendTelegramAlert(params: {
  mint: string;
  symbol: string;
  name: string;
  purchases: Purchase[];
  totalWallets: number;
  confluenceMin: number;
  priceUsd?: number;
  marketCap?: number;
  liquidity?: number;
  ageMin?: number;
}) {
  const { mint, symbol, name, purchases, totalWallets, confluenceMin, priceUsd, marketCap, liquidity, ageMin } = params;

  const walletLines = purchases
    .map((p) => `• <code>${p.wallet.slice(0, 6)}...${p.wallet.slice(-4)}</code> (${p.amountSol.toFixed(2)} SOL)`)
    .join("\n");

  const statsLine = [
    priceUsd ? `💵 $${priceUsd < 0.0001 ? priceUsd.toExponential(2) : priceUsd.toFixed(6)}` : null,
    marketCap ? `📊 MCap: ${fmtUsd(marketCap)}` : null,
    liquidity ? `💧 Liq: ${fmtUsd(liquidity)}` : null,
    ageMin ? `⏰ Età: ${ageMin < 60 ? ageMin + "min" : Math.round(ageMin / 60) + "h"}` : null,
  ].filter(Boolean).join("  |  ");

  const text = `🚨 <b>SMART MONEY CONFLUENCE</b> 🚨

<b>${name}</b> — $${symbol}
${statsLine}

📋 <b>Contract:</b>
<code>${mint}</code>

👛 <b>${purchases.length}/${totalWallets} wallet concordanti</b>
${walletLines}

⏱ Tempo confluenza: ${confluenceMin === 0 ? "&lt;1" : confluenceMin} min

🔗 <a href="https://dexscreener.com/solana/${mint}">DexScreener</a> · <a href="https://bullx.io/terminal?chainId=1399811149&address=${mint}">BullX</a> · <a href="https://photon-sol.tinyastro.io/en/r/@cMain/${mint}">Photon</a> · <a href="https://gmgn.ai/sol/token/${mint}">GMGN</a>`;

  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

// ─── LOG ALERT SU SUPABASE ────────────────────────────────────────────────────
async function logAlert(mint: string, symbol: string | undefined, purchases: Purchase[], confluenceMin: number) {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_KEY");
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  await fetch(`${SUPABASE_URL}/rest/v1/alerts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      token_address: mint,
      token_symbol: symbol,
      wallet_count: purchases.length,
      wallet_addresses: purchases.map((p) => p.wallet),
      confluence_minutes: confluenceMin,
    }),
  });
}

// ─── WALLETS UPDATE ───────────────────────────────────────────────────────────
async function handleWalletsUpdate(req: Request): Promise<Response> {
  if (WEBHOOK_SECRET) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== WEBHOOK_SECRET) return json({ error: "Unauthorized" }, 401);
  }

  const body = await req.json() as { wallets: string[] };
  const wallets = body.wallets || [];
  if (!wallets.length) return json({ error: "No wallets" }, 400);

  await redis.del(K_WALLETS);
  await redis.sadd(K_WALLETS, ...wallets);
  await redis.set(K_TOTAL, String(wallets.length));

  console.log(`[Wallets] Aggiornati: ${wallets.length}`);
  return json({ ok: true, count: wallets.length });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
