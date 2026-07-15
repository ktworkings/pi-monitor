/**
 * Pi/Stellar Wallet Monitor — IN-MEMORY, NO PERSISTENCE
 * ---------------------------------------------------------------
 * - Add wallets by pasting phrases (one per line, bulk add supported)
 * - Phrases live only in a JS Map in RAM, nothing written to disk
 * - Every ~30s polls Horizon for balances and claimable balances
 * - Email alerts on: new claimable balance, ~24h/~2h before unlock, 
 *   and any payment in/out (with tx hash)
 * - Dashboard shows phrase preview (first 3 words) for easy identification
 * - Read-only, never builds or submits transactions
 * ---------------------------------------------------------------
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const bip39 = require('bip39');
const hdkey = require('ed25519-hd-key');
const { Keypair, Server } = require('stellar-sdk');

const app = express();
app.use(express.json());

const CONFIG = {
  PORT: 3010,
  HORIZON_URL: 'http://your-horizon-node:31401',
  POLL_INTERVAL_MS: 30000,
  RESERVE_PI: 1,

  EMAIL_HOST: 'smtp.gmail.com',
  EMAIL_PORT: 587,
  EMAIL_USER: 'your-email@gmail.com',
  EMAIL_PASS: 'your-app-password',
  EMAIL_TO: 'recipient@example.com',

  DASH_USER: 'admin',
  DASH_PASS: 'password123',
};
// ════════════════════════════════════════════════════════════════

const PI_DERIVATION_PATH = "m/44'/314159'/0'";
const REMINDER_24H_MS = 24 * 60 * 60 * 1000;
const REMINDER_2H_MS = 2 * 60 * 60 * 1000;
const REMINDER_WINDOW_MS = 5 * 60 * 1000;

let mailer = null;
try {
  mailer = nodemailer.createTransport({
    host: CONFIG.EMAIL_HOST,
    port: CONFIG.EMAIL_PORT,
    secure: false,
    auth: { user: CONFIG.EMAIL_USER, pass: CONFIG.EMAIL_PASS },
  });
} catch (e) {
  console.warn('[email] transport failed, alerts disabled:', e.message);
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
  if (!mailer) { console.warn('[email] not configured, skipping:', subject); return; }
  try {
    await mailer.sendMail({ from: CONFIG.EMAIL_USER, to: CONFIG.EMAIL_TO, subject, text, html });
  } catch (e) {
    console.error('[email] failed:', e.message);
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

const authRequired = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token || !sessions.has(token)) return res.status(401).json({ success: false, error: 'unauthorized' });
  req.authToken = token;
  next();
};

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
    // Determine the earliest unlock time across all claimable balances
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
      id: w.id, label: w.label, public_key: w.public_key, phrase_preview: w.phrase_preview || getPhrasePreview(w.phrase), created_at: w.created_at,
      ...snap,
      earliest_unlock,
    };
  }).sort((a, b) => {
    // Sort by earliest unlock time — soonest first, wallets with no unlock go to the end
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

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi Wallet Monitor</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a1420; color: #b8c9d9; font-family: 'Segoe UI', Arial, sans-serif; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 30px; border-bottom: 1px solid rgba(0,212,255,.15); padding-bottom: 20px; }
    .title { font-size: 24px; font-weight: 800; color: #00d4ff; }
    .logout-btn { background: #f44336; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 700; }
    .logout-btn:hover { background: #d32f2f; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 30px; }
    .stat-card { background: #101f30; border: 1px solid #17324a; border-radius: 8px; padding: 16px; }
    .stat-label { font-size: 11px; color: #00d4ff; font-weight: 700; text-transform: uppercase; margin-bottom: 8px; }
    .stat-value { font-size: 24px; font-weight: 800; color: #4caf50; }
    .card { background: #101f30; border: 1px solid #17324a; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .card-title { font-size: 16px; font-weight: 800; color: #00d4ff; margin-bottom: 16px; }
    .form-row { display: flex; flex-direction: column; gap: 12px; }
    .form-row > div { display: flex; flex-direction: column; }
    label { font-size: 12px; color: #00d4ff; font-weight: 700; text-transform: uppercase; margin-bottom: 6px; }
    input, textarea { background: #0c1c2c; color: #b8c9d9; border: 1px solid #17324a; border-radius: 6px; padding: 8px 12px; font-family: inherit; font-size: 13px; }
    input:focus, textarea:focus { outline: none; border-color: #00d4ff; }
    .btn { background: #1976d2; color: #fff; border: none; padding: 10px 16px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 700; }
    .btn:hover { background: #1565c0; }
    .btn-primary { background: #00d4ff; color: #04121f; }
    .btn-primary:hover { background: #00b8cc; }
    .tbl-outer { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    thead th { background: #0e2233; color: #00d4ff; padding: 12px; font-size: 11px; font-weight: 800; text-transform: uppercase; text-align: left; border-bottom: 1px solid rgba(0,212,255,.15); }
    td { padding: 12px; border-bottom: 1px solid rgba(0,212,255,.08); }
    .row-num { font-size: 18px; font-weight: 800; color: #fff; }
    .addr-full { font-family: 'Courier New', monospace; font-size: 12px; color: #a8d8ff; word-break: break-all; }
    .wallet-label { font-size: 11px; color: #00d4ff; font-weight: 700; text-transform: uppercase; margin-bottom: 4px; }
    .copy-link { background: none; border: none; color: #5aa; font-size: 10px; text-decoration: underline; cursor: pointer; padding: 0; margin-top: 4px; }
    .bal-val { font-size: 18px; font-weight: 800; color: #4caf50; }
    .bal-sub { font-size: 11px; color: #778; margin-top: 2px; }
    .status-active { color: #4caf50; font-weight: 800; }
    .status-wait { color: #ffc107; font-weight: 800; }
    .status-err { color: #f44336; font-weight: 800; }
    .remove-btn { background: #f44336; color: #fff; border: none; padding: 4px 8px; border-radius: 4px; font-size: 10px; cursor: pointer; margin-top: 8px; }
    .remove-btn:hover { background: #d32f2f; }
    .expand-btn { background: none; border: none; color: #00d4ff; font-size: 11px; cursor: pointer; text-decoration: underline; padding: 4px 0; margin-top: 4px; }
    .hidden { display: none; }
    .loading { text-align: center; padding: 24px; color: #00d4ff; }
    .empty { text-align: center; padding: 30px; color: #556; }
    .cb-row { background: rgba(0,212,255,.03); }
    .cb-wrap { padding: 16px; }
    .cb-scroll { overflow-x: auto; }
    .cb-scroll table { font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">◎ Pi Wallet Monitor</div>
      <button class="logout-btn" onclick="doLogout()">Sign Out</button>
    </div>

    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Wallets</div>
        <div class="stat-value" id="statTotal">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Available PI</div>
        <div class="stat-value" id="statAvail">0.0000000</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Claimable PI</div>
        <div class="stat-value" id="statClaimable">0.0000000</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Claimable Bals</div>
        <div class="stat-value" id="statCbCount">0</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Add Wallets (Bulk)</div>
      <div class="form-row">
        <div style="width: 100%"><label>Paste multiple 24-word phrases (one per line)</label><textarea id="phrases" placeholder="word1 word2 word3 ... word24&#10;word1 word2 word3 ... word24" style="width: 100%; height: 120px;"></textarea></div>
        <div style="flex:0"><button class="btn btn-primary" id="addBtn" onclick="addWallets()" style="margin-top: 8px;">Add Wallets</button></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Monitored Wallets</div>
      <div id="walletsTbl"><div class="loading">Loading…</div></div>
    </div>
  </div>

  <script>
    var authToken = localStorage.getItem('authToken');

    function doLogout() {
      localStorage.removeItem('authToken');
      location.href = '/login.html';
    }

    async function addWallets() {
      var phrases = document.getElementById('phrases').value.trim();
      if (!phrases) { alert('Paste one or more phrases'); return; }
      var btn = document.getElementById('addBtn');
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        var r = await fetch('/api/wallets', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+authToken}, body: JSON.stringify({ phrases: phrases }) });
        var d = await r.json();
        if (!d.success) { alert('Error: ' + d.error); return; }
        alert('Added ' + d.added + ' wallet(s)');
        document.getElementById('phrases').value = '';
        refresh();
      } catch (e) { alert('Error: ' + e.message); }
      finally { btn.disabled = false; btn.textContent = 'Add Wallets'; }
    }

    async function deleteWallet(id) {
      if (!confirm('Stop monitoring this wallet?')) return;
      await fetch('/api/wallets/' + id, { method:'DELETE', headers:{'Authorization':'Bearer '+authToken} });
      refresh();
    }

    function copyAddr(addr, btnEl) {
      navigator.clipboard.writeText(addr).then(function() {
        var orig = btnEl.textContent;
        btnEl.textContent = 'Copied!';
        setTimeout(function() { btnEl.textContent = orig; }, 1400);
      });
    }

    function toggleCb(rowId) {
      var el = document.getElementById(rowId);
      el.classList.toggle('hidden');
    }

    function claimablesTable(list) {
      if (!list || !list.length) return '';
      return '<div class="cb-scroll"><table><thead><tr><th>Amount</th><th>Unlock Time</th></tr></thead><tbody>' +
        list.map(cb => '<tr><td>' + cb.amount + ' PI</td><td>' + (cb.unlock_time ? new Date(cb.unlock_time).toLocaleString() : 'Claimable now') + '</td></tr>').join('') +
        '</tbody></table></div>';
    }

    function formatUnlock(isoStr) {
      if (!isoStr) return '<span style="color:#556;">No unlock pending</span>';
      var d = new Date(isoStr);
      var now = Date.now();
      var diff = d.getTime() - now;
      var timeStr = d.toLocaleString();
      if (diff <= 0) return '<span style="color:#4caf50;font-weight:700;">Claimable NOW</span>';
      // Show remaining time
      var hrs = Math.floor(diff / 3600000);
      var mins = Math.floor((diff % 3600000) / 60000);
      var remaining = hrs > 24 ? Math.floor(hrs/24) + 'd ' + (hrs%24) + 'h' : hrs + 'h ' + mins + 'm';
      return '<span style="color:#ffc107;font-weight:700;">' + timeStr + '</span><br><span style="font-size:10px;color:#ff9800;">in ' + remaining + '</span>';
    }

    function renderWallets(list) {
      var el = document.getElementById('walletsTbl');
      if (!list.length) { el.innerHTML = '<div class="empty">No wallets yet</div>'; return; }

      var rows = list.map(function(w, i) {
        var cbCount = (w.claimables || []).length;
        var status = w.error ? '<span class="status-err">' + w.error + '</span>' : (w.account_exists ? '<span class="status-active">FUNDED</span>' : '<span class="status-wait">UNFUNDED</span>');
        var rowId = 'cb-' + w.id;
        return '<tr>' +
          '<td class="row-num">' + (i+1) + '</td>' +
          '<td><div class="wallet-label">' + (w.phrase_preview || 'unknown') + ' ...</div><div class="addr-full">' + w.public_key + '</div><button class="copy-link" onclick="copyAddr(\\''+w.public_key+'\\', this)">copy address</button></td>' +
          '<td><div class="bal-val">' + (w.available_balance || '0.0000000') + ' PI</div><div class="bal-sub">claimable ' + (w.claimable_total || '0.0000000') + ' PI (' + cbCount + ')</div>' + (cbCount ? '<button class="expand-btn" onclick="toggleCb(\\''+rowId+'\\')">Show '+cbCount+' ▾</button>' : '') + '</td>' +
          '<td>' + formatUnlock(w.earliest_unlock) + '</td>' +
          '<td>' + status + '<br><span style="font-size:10px;color:#556">upd ' + (w.updated_at ? new Date(w.updated_at).toLocaleTimeString() : '—') + '</span><br><button class="remove-btn" onclick="deleteWallet(\\''+w.id+'\\')">Remove</button><div id="' + rowId + '" class="hidden" style="margin-top:8px">' + claimablesTable(w.claimables) + '</div></td>' +
          '</tr>';
      }).join('');

      el.innerHTML = '<div class="tbl-outer"><table><thead><tr><th>#</th><th>Phrase / Address</th><th>Balance</th><th>Unlock Time</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    async function refresh() {
      if (!authToken) return;
      try {
        var r = await fetch('/api/wallets', { headers: { 'Authorization': 'Bearer ' + authToken } });
        if (r.status === 401) { doLogout(); return; }
        var d = await r.json();
        document.getElementById('statTotal').textContent = d.stats.total_wallets;
        document.getElementById('statAvail').textContent = parseFloat(d.stats.total_available).toFixed(4);
        document.getElementById('statClaimable').textContent = parseFloat(d.stats.total_claimable).toFixed(4);
        document.getElementById('statCbCount').textContent = d.stats.total_claimable_count;
        renderWallets(d.wallets);
      } catch (e) { console.error(e); }
    }

    if (!authToken) location.href = '/login.html';
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`);
});

app.get('/login.html', (req, res) => {
  res.send(`<!DOCTYPE html><html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi Wallet Monitor - Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a1420; color: #b8c9d9; font-family: 'Segoe UI', Arial, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #101f30; border: 1px solid #17324a; border-radius: 8px; padding: 40px; width: 100%; max-width: 300px; }
    .title { font-size: 20px; font-weight: 800; color: #00d4ff; margin-bottom: 30px; text-align: center; }
    .form-group { margin-bottom: 16px; }
    label { display: block; font-size: 12px; color: #00d4ff; font-weight: 700; margin-bottom: 6px; }
    input { width: 100%; background: #0c1c2c; color: #b8c9d9; border: 1px solid #17324a; border-radius: 6px; padding: 10px; font-size: 13px; }
    input:focus { outline: none; border-color: #00d4ff; }
    .btn { width: 100%; background: #00d4ff; color: #04121f; border: none; padding: 12px; border-radius: 6px; font-weight: 800; font-size: 13px; cursor: pointer; margin-top: 10px; }
    .btn:hover { background: #00b8cc; }
    .error { color: #f44336; font-size: 12px; margin-top: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">◎ Pi Wallet Monitor</div>
    <div class="form-group">
      <label>Username</label>
      <input id="user" placeholder="admin">
    </div>
    <div class="form-group">
      <label>Password</label>
      <input id="pass" type="password" placeholder="••••••">
    </div>
    <button class="btn" onclick="login()">Sign In</button>
    <div id="error" class="error"></div>
  </div>
  <script>
    async function login() {
      var user = document.getElementById('user').value;
      var pass = document.getElementById('pass').value;
      if (!user || !pass) { alert('Enter username and password'); return; }
      try {
        var r = await fetch('/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ user: user, pass: pass }) });
        var d = await r.json();
        if (!d.success) { document.getElementById('error').textContent = d.error; return; }
        localStorage.setItem('authToken', d.token);
        location.href = '/';
      } catch (e) { document.getElementById('error').textContent = e.message; }
    }
    document.getElementById('pass').addEventListener('keypress', function(e) { if (e.key === 'Enter') login(); });
  </script>
</body>
</html>`);
});

app.listen(CONFIG.PORT, () => console.log('✓ Pi Wallet Monitor running on port ' + CONFIG.PORT));
