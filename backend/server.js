/**
 * Pi/Stellar Wallet Monitor — Backend API
 * ---------------------------------------------------------------
 * - Add wallets by pasting phrases (one per line, bulk add supported)
 * - Phrases live only in a JS Map in RAM, nothing written to disk
 * - Every ~30s polls Horizon for balances and claimable balances
 * - Email alerts via Brevo SMTP on: new claimable balance,
 *   ~24h/~2h before unlock, and any payment in/out (with tx hash)
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
const { Keypair, Server } = require('stellar-sdk');

const app = express();
app.use(express.json());
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

  // Brevo API
  BREVO_API_KEY: process.env.BREVO_API_KEY || '',
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || 'Pi Wallet Monitor',
  EMAIL_FROM_ADDRESS: process.env.EMAIL_FROM_ADDRESS || '',
  EMAIL_TO: process.env.EMAIL_TO || '',

  DASH_USER: process.env.DASH_USER || 'admin',
  DASH_PASS: process.env.DASH_PASS || 'password123',
};

// ════════════════════════════════════════════════════════════════

const PI_DERIVATION_PATH = "m/44'/314159'/0'";
const REMINDER_24H_MS = 24 * 60 * 60 * 1000;
const REMINDER_2H_MS = 2 * 60 * 60 * 1000;
const REMINDER_WINDOW_MS = 5 * 60 * 1000;

let mailerReady = !!(CONFIG.BREVO_API_KEY && CONFIG.EMAIL_FROM_ADDRESS && CONFIG.EMAIL_TO);
if (!mailerReady) {
  console.warn('[email] Brevo API key, from address, or recipient not configured — alerts disabled');
}

const wallets = new Map();
const snapshot = {};
const claimableTracked = new Map();
const seenPayments = new Set();
const sessions = new Map();

function deriveKeypair(phrase) {
  const seed = bip39.mnemonicToSeedSync(phrase);
  const derived = hdkey.derivePath(PI_DERIVATION_PATH, seed.toString('hex'));
  return Keypair.fromRawEd25519Seed(Buffer.from(derived.key));
}

function getPhrasePreview(phrase) {
  return phrase.trim().split(' ').slice(0, 3).join(' ');
}

async function sendEmail(subject, text, html) {
  if (!mailerReady) { console.warn('[email] not configured, skipping:', subject); return; }
  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: CONFIG.EMAIL_FROM_NAME, email: CONFIG.EMAIL_FROM_ADDRESS },
      to: [{ email: CONFIG.EMAIL_TO }],
      subject,
      textContent: text,
      htmlContent: html,
    }, {
      headers: {
        'api-key': CONFIG.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  } catch (e) {
    console.error('[email] Brevo API failed:', e.response?.data?.message || e.message);
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
  </table>
  </body></html>`;
}

async function pollWallet(w) {
  if (!w) return;
  const h = new Server(CONFIG.HORIZON_URL);
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
      let unlockTime = null;

      function extractAbsBefore(pred) {
        if (!pred) return null;
        if (pred.abs_before) return pred.abs_before;
        if (pred.not && pred.not.abs_before) return pred.not.abs_before;
        if (pred.and) for (let p of pred.and) { let t = extractAbsBefore(p); if (t) return t; }
        if (pred.or) for (let p of pred.or) { let t = extractAbsBefore(p); if (t) return t; }
        return null;
      }

      if (cb.predicate) unlockTime = extractAbsBefore(cb.predicate);

      claimables.push({
        id: cb.id,
        amount: cb.amount,
        unlock_time: unlockTime ? new Date(unlockTime).toISOString() : null,
      });
    }

    snapshot[id] = {
      account_exists: true,
      available_balance: availBal.toFixed(7),
      raw_balance: parseFloat(rawBal).toFixed(7),
      claimable_total: claimableTotal.toFixed(7),
      claimables: claimables,
      updated_at: new Date().toISOString(),
      error: null
    };

    let isFirstPoll = !w.last_payment_cursor;
    const payments = await h.payments().forAccount(w.public_key).order('desc').limit(10).call().catch(() => ({ records: [] }));
    for (const p of payments.records) {
      if (w.last_payment_cursor && seenPayments.has(p.id)) continue;
      seenPayments.add(p.id);
      if (isFirstPoll) continue;

      const direction = p.to === w.public_key ? 'IN' : (p.from === w.public_key ? 'OUT' : '?');
      const amt = p.amount || p.starting_balance || '?';
      const txHash = p.transaction_hash;
      const phrasePreview = w.phrase_preview || getPhrasePreview(w.phrase);

      await sendEmail(
        `${direction === 'IN' ? '🟢' : '🔴'} Pi ${direction} — ${phrasePreview}`,
        `Phrase: ${phrasePreview}\nAmount: ${amt} PI\nDirection: ${direction}\nTx: ${txHash}`,
        emailHtml({
          icon: direction === 'IN' ? '🟢' : '🔴',
          title: `Payment ${direction === 'IN' ? 'Received' : 'Sent'}`,
          accent: direction === 'IN' ? '#4caf50' : '#f44336',
          rows: [
            { label: 'Phrase', value: phrasePreview, mono: true },
            { label: 'Amount', value: `${amt} PI`, big: true },
            { label: 'Direction', value: direction === 'IN' ? 'Incoming ⬇' : 'Outgoing ⬆' },
            { label: 'Address', value: w.public_key, mono: true },
            { label: 'Tx Hash', value: txHash, mono: true },
            { label: 'Time', value: new Date(p.created_at).toLocaleString() },
          ],
        })
      );
    }
    if (payments.records.length) w.last_payment_cursor = payments.records[0].paging_token;
    else if (isFirstPoll) w.last_payment_cursor = 'checked';

    // Process claimables for unlock notifications
    for (const cb of claimables) {
      let tracked = claimableTracked.get(cb.id);
      if (!tracked) {
        tracked = { wallet_id: w.id, amount: cb.amount, unlock_time: cb.unlock_time, notified_24h: false, notified_2h: false };
        claimableTracked.set(cb.id, tracked);
        const phrasePreview = w.phrase_preview || getPhrasePreview(w.phrase);

        await sendEmail(
          `🟢 New claimable balance — ${phrasePreview}`,
          `Phrase: ${phrasePreview}\nAmount: ${cb.amount} PI\nUnlock: ${cb.unlock_time || 'Already claimable'}`,
          emailHtml({
            icon: '🟢', title: 'New Claimable Balance', accent: '#4caf50',
            rows: [
              { label: 'Phrase', value: phrasePreview, mono: true },
              { label: 'Amount', value: `${cb.amount} PI`, big: true },
              { label: 'Address', value: w.public_key, mono: true },
              { label: 'Unlock Time', value: cb.unlock_time ? new Date(cb.unlock_time).toLocaleString() : 'Already claimable' },
            ],
          })
        );
        continue;
      }

      if (cb.unlock_time) {
        const phrasePreview = w.phrase_preview || getPhrasePreview(w.phrase);
        const msLeft = new Date(cb.unlock_time).getTime() - Date.now();

        if (!tracked.notified_24h && msLeft <= REMINDER_24H_MS && msLeft > REMINDER_24H_MS - REMINDER_WINDOW_MS) {
          tracked.notified_24h = true;
          await sendEmail(
            `🟡 Unlocks in ~24h — ${phrasePreview}`,
            `Phrase: ${phrasePreview}\nAmount: ${cb.amount} PI\nUnlock: ${new Date(cb.unlock_time).toLocaleString()}`,
            emailHtml({
              icon: '🟡', title: 'Unlocks in ~24 Hours', accent: '#ffc107',
              rows: [
                { label: 'Phrase', value: phrasePreview, mono: true },
                { label: 'Amount', value: `${cb.amount} PI`, big: true },
                { label: 'Address', value: w.public_key, mono: true },
                { label: 'Unlock', value: new Date(cb.unlock_time).toLocaleString() },
              ],
            })
          );
        }

        if (!tracked.notified_2h && msLeft <= REMINDER_2H_MS && msLeft > REMINDER_2H_MS - REMINDER_WINDOW_MS) {
          tracked.notified_2h = true;
          await sendEmail(
            `🟠 Unlocks in ~2h — ${phrasePreview}`,
            `Phrase: ${phrasePreview}\nAmount: ${cb.amount} PI\nUnlock: ${new Date(cb.unlock_time).toLocaleString()}`,
            emailHtml({
              icon: '🟠', title: 'Unlocks in ~2 Hours', accent: '#ff9800',
              rows: [
                { label: 'Phrase', value: phrasePreview, mono: true },
                { label: 'Amount', value: `${cb.amount} PI`, big: true },
                { label: 'Address', value: w.public_key, mono: true },
                { label: 'Unlock', value: new Date(cb.unlock_time).toLocaleString() },
              ],
            })
          );
        }
      }
    }
  } catch (e) {
    snapshot[id] = { error: e.message, account_exists: false, updated_at: new Date().toISOString() };
  }
}

setInterval(() => {
  wallets.forEach(w => pollWallet(w));
}, CONFIG.POLL_INTERVAL_MS);

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
  if (user !== CONFIG.DASH_USER || pass !== CONFIG.DASH_PASS) return res.status(401).json({ success: false, error: 'invalid credentials' });
  const token = crypto.randomUUID();
  sessions.set(token, { user, created: Date.now() });
  res.json({ success: true, token });
});

app.get('/api/verify-token', authRequired, (req, res) => {
  res.json({ success: true });
});

app.post('/api/wallets', authRequired, async (req, res) => {
  try {
    const { phrases } = req.body || {};
    if (!phrases || !phrases.trim()) return res.status(400).json({ success: false, error: 'phrases required' });

    const phraseList = phrases.split('\n').map(p => p.trim()).filter(p => p.length > 0);
    if (phraseList.length === 0) return res.status(400).json({ success: false, error: 'no valid phrases' });

    const results = [];
    for (const phrase of phraseList) {
      try {
        const kp = deriveKeypair(phrase);
        const id = crypto.randomUUID();
        const preview = getPhrasePreview(phrase);
        const label = kp.publicKey().slice(0, 8);
        const w = {
          id,
          label,
          phrase: phrase.trim(),
          phrase_preview: preview,
          public_key: kp.publicKey(),
          created_at: new Date().toISOString(),
          last_payment_cursor: null
        };
        wallets.set(id, w);
        pollWallet(w);
        results.push({ id, public_key: kp.publicKey(), preview });
      } catch (e) {
        results.push({ error: e.message, phrase_preview: getPhrasePreview(phrase) });
      }
    }

    res.json({ success: true, added: results.filter(r => !r.error).length, results });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

app.get('/api/wallets', authRequired, (req, res) => {
  const list = Array.from(wallets.values()).map(w => {
    const snap = snapshot[w.id] || {};
    let earliest_unlock = null;
    if (snap.claimables && snap.claimables.length > 0) {
      const unlockTimes = snap.claimables
        .map(cb => cb.unlock_time)
        .filter(t => t !== null);
      if (unlockTimes.length > 0) {
        unlockTimes.sort((a, b) => new Date(a) - new Date(b));
        earliest_unlock = unlockTimes[0];
      }
    }
    return {
      id: w.id,
      label: w.label,
      public_key: w.public_key,
      phrase_preview: w.phrase_preview || getPhrasePreview(w.phrase),
      created_at: w.created_at,
      account_exists: false,
      available_balance: '0.0000000',
      raw_balance: '0.0000000',
      claimable_total: '0.0000000',
      claimables: [],
      error: null,
      updated_at: null,
      ...snap,
      earliest_unlock,
    };
  }).sort((a, b) => {
    if (a.earliest_unlock && b.earliest_unlock) return new Date(a.earliest_unlock) - new Date(b.earliest_unlock);
    if (a.earliest_unlock && !b.earliest_unlock) return -1;
    if (!a.earliest_unlock && b.earliest_unlock) return 1;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  const totals = list.reduce((acc, w) => {
    acc.available += parseFloat(w.available_balance || 0);
    acc.claimable += parseFloat(w.claimable_total || 0);
    acc.claimableCount += (w.claimables || []).length;
    return acc;
  }, { available: 0, claimable: 0, claimableCount: 0 });

  res.json({
    success: true,
    wallets: list,
    stats: {
      total_wallets: list.length,
      total_available: totals.available.toFixed(7),
      total_claimable: totals.claimable.toFixed(7),
      total_claimable_count: totals.claimableCount,
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
  res.json({ success: true });
});

app.listen(CONFIG.PORT, () => console.log('✓ Pi Wallet Monitor API running on port ' + CONFIG.PORT));
