import React, { useState, useEffect, useCallback } from 'react';
import { getWallets, addWallets, deleteWallet, sendTestEmail } from '../api';
import './Dashboard.css';

function formatUnlock(isoStr, isClaimableNow) {
  if (isClaimableNow) return <span className="unlock-now">🔓 Claimable NOW</span>;
  if (!isoStr) return <span className="no-unlock">No lock</span>;

  const d = new Date(isoStr);
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return <span className="unlock-now">🔓 Claimable NOW</span>;

  const hrs = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  const remaining = hrs > 24
    ? `${Math.floor(hrs / 24)}d ${hrs % 24}h`
    : `${hrs}h ${mins}m`;

  return (
    <>
      <span className="unlock-pending">{d.toLocaleString()}</span>
      <br />
      <span className="unlock-remaining">🔒 in {remaining}</span>
    </>
  );
}

function ClaimablesTable({ claimables }) {
  if (!claimables || claimables.length === 0) return null;
  return (
    <table className="cb-table">
      <thead>
        <tr><th>Amount</th><th>Unlock Time</th><th>Status</th></tr>
      </thead>
      <tbody>
        {claimables.map((cb) => (
          <tr key={cb.id} className={cb.is_claimable_now ? 'cb-unlocked' : ''}>
            <td>{cb.amount} PI</td>
            <td>{cb.unlock_time ? new Date(cb.unlock_time).toLocaleString() : '—'}</td>
            <td>{cb.is_claimable_now
              ? <span className="status-unclaimed">🔓 Unclaimed</span>
              : <span className="status-locked">🔒 Locked</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WalletRow({ wallet, index, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [copyText, setCopyText] = useState('copy address');
  const cbCount = (wallet.claimables || []).length;
  const unclaimedCount = wallet.unlocked_unclaimed_count || 0;

  const handleCopy = () => {
    navigator.clipboard.writeText(wallet.public_key).then(() => {
      setCopyText('Copied!');
      setTimeout(() => setCopyText('copy address'), 1400);
    });
  };

  const handleDelete = () => {
    if (window.confirm('Stop monitoring this wallet?')) onDelete(wallet.id);
  };

  const status = wallet.error
    ? <span className="status-err">{wallet.error}</span>
    : wallet.account_exists
      ? <span className="status-active">FUNDED</span>
      : wallet.polled
        ? <span className="status-wait">UNFUNDED</span>
        : <span className="status-pending">PENDING…</span>;

  return (
    <tr className={unclaimedCount > 0 ? 'row-unclaimed' : ''}>
      <td className="row-num">{index + 1}</td>
      <td>
        <div className="wallet-label">{wallet.phrase_preview || 'unknown'} ...</div>
        <div className="addr-full">{wallet.public_key}</div>
        <button className="copy-link" onClick={handleCopy}>{copyText}</button>
      </td>
      <td>
        <div className="bal-val">{wallet.available_balance || '0.0000000'} PI</div>
        <div className="bal-sub">claimable {wallet.claimable_total || '0.0000000'} PI</div>
        {unclaimedCount > 0 && (
          <div className="unclaimed-badge">🔓 {wallet.unlocked_unclaimed_total} PI unclaimed</div>
        )}
      </td>
      <td>
        <div className="lockup-info">
          <span className="lockup-count">{wallet.lockup_count || 0} lockup{(wallet.lockup_count || 0) !== 1 ? 's' : ''}</span>
        </div>
        {unclaimedCount > 0 && <div className="next-unlock">{formatUnlock(null, true)}</div>}
        {!unclaimedCount && wallet.earliest_unlock && (
          <div className="next-unlock">
            <span className="next-unlock-label">Next unlock:</span><br />
            {formatUnlock(wallet.earliest_unlock, false)}
          </div>
        )}
        {!unclaimedCount && !wallet.earliest_unlock && <span className="no-unlock">No pending unlocks</span>}
        {cbCount > 0 && (
          <button className="expand-btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Hide ▴' : `Show ${cbCount} ▾`}
          </button>
        )}
        {expanded && <ClaimablesTable claimables={wallet.claimables} />}
      </td>
      <td>
        {status}<br />
        <span className="updated-time">upd {wallet.updated_at ? new Date(wallet.updated_at).toLocaleTimeString() : '—'}</span><br />
        <button className="remove-btn" onClick={handleDelete}>Remove</button>
      </td>
    </tr>
  );
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function Dashboard({ onLogout }) {
  const [wallets, setWallets] = useState([]);
  const [stats, setStats] = useState({
    total_wallets: 0,
    total_available: '0.0000000',
    total_claimable: '0.0000000',
    total_claimable_count: 0,
    total_unlocked_unclaimed: '0.0000000',
    total_unlocked_unclaimed_count: 0,
    polled_wallets: 0,
    tier_counts: { urgent: 0, soon: 0, normal: 0, idle: 0 },
    poll_lag_avg_ms: 0,
    poll_lag_max_ms: 0,
    rate_limit_rps: 0,
    rate_limit_active: false,
    in_flight: 0,
    queue_depth: 0,
    stream_active: false,
    email_configured: false,
    email_verified: false,
    email_sent: 0,
    email_failed: 0,
    email_last_error: null,
  });
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, pages: 0 });
  const [page, setPage] = useState(1);
  const [phrases, setPhrases] = useState('');
  const [adding, setAdding] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await getWallets(page, 50);
      if (data.success) {
        setWallets(data.wallets);
        setPagination(data.pagination);
        // Stats are now computed fresh on the backend each request
        // No need for client-side "stable stats" logic
        setStats(data.stats);
      }
    } catch (err) {
      console.error('Failed to refresh:', err);
    }
  }, [page]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleAdd = async () => {
    if (!phrases.trim()) { alert('Paste one or more phrases'); return; }
    setAdding(true);
    try {
      const data = await addWallets(phrases);
      if (data.success) {
        setPhrases('');
        const dupExisting = data.duplicates_existing || 0;
        const dupBatch = data.duplicates_in_batch || 0;
        const dupTotal = dupExisting + dupBatch;
        const lines = [];
        if (data.queued > 0) {
          lines.push(`${data.queued} unique phrase${data.queued === 1 ? '' : 's'} queued for processing.`);
        }
        if (dupTotal > 0) {
          const parts = [];
          if (dupExisting > 0) parts.push(`${dupExisting} already tracked`);
          if (dupBatch > 0) parts.push(`${dupBatch} duplicate${dupBatch === 1 ? '' : 's'} in your input`);
          lines.push(`Skipped ${dupTotal} (${parts.join(', ')}).`);
        }
        if (data.message) lines.push(data.message);
        lines.push(`Total wallets: ${data.total}.`);
        alert(lines.join('\n'));
        await refresh();
      } else {
        alert('Error: ' + data.error);
      }
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id) => {
    await deleteWallet(id);
    refresh();
  };

  const handleTestEmail = async () => {
    setTestingEmail(true);
    try {
      const data = await sendTestEmail();
      if (data.success) {
        alert(`Test email sent to ${data.sent_to}.\nCheck your inbox (and spam) within a minute.`);
      } else {
        alert('Test email failed: ' + (data.error || 'unknown error'));
      }
    } catch (err) {
      alert('Test email failed: ' + err.message);
    } finally {
      setTestingEmail(false);
      await refresh();
    }
  };

  const polledPct = stats.total_wallets > 0
    ? Math.round(((stats.polled_wallets || 0) / stats.total_wallets) * 100)
    : 0;

  return (
    <div className="container">
      <div className="header">
        <div className="title">◎ Pi Wallet Monitor</div>
        <button className="logout-btn" onClick={onLogout}>Sign Out</button>
      </div>

      <div className="stats">
        <div className="stat-card">
          <div className="stat-label">Wallets</div>
          <div className="stat-value">{stats.total_wallets}</div>
          {stats.polled_wallets < stats.total_wallets && (
            <div className="stat-sub">{stats.polled_wallets} polled ({polledPct}%)</div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label">Available PI</div>
          <div className="stat-value">{parseFloat(stats.total_available).toFixed(4)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Claimable PI</div>
          <div className="stat-value">{parseFloat(stats.total_claimable).toFixed(4)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Lockups</div>
          <div className="stat-value">{stats.total_claimable_count}</div>
        </div>
        <div className="stat-card stat-card-alert">
          <div className="stat-label">Unlocked (Unclaimed)</div>
          <div className="stat-value stat-value-alert">{parseFloat(stats.total_unlocked_unclaimed || 0).toFixed(4)} PI</div>
          <div className="stat-sub">{stats.total_unlocked_unclaimed_count || 0} balances</div>
        </div>
      </div>

      <div className="system-status">
        <span className="sys-item"><b>Queue</b> {stats.queue_depth || 0}</span>
        <span className="sys-item"><b>In-flight</b> {stats.in_flight || 0}</span>
        <span className={`sys-item ${stats.rate_limit_active ? 'sys-warn' : ''}`}>
          <b>Rate</b> {stats.rate_limit_rps || 0} rps{stats.rate_limit_active ? ' · throttled' : ''}
        </span>
        <span className="sys-item"><b>Avg lag</b> {formatDuration(stats.poll_lag_avg_ms)}</span>
        <span className="sys-item"><b>Max lag</b> {formatDuration(stats.poll_lag_max_ms)}</span>
        <span className={`sys-item ${stats.stream_active ? 'sys-ok' : 'sys-warn'}`}>
          <b>Stream</b> {stats.stream_active ? '● live' : '○ off'}
        </span>
        <span className="sys-item">
          <b>Tiers</b>{' '}
          <span title="urgent">U:{stats.tier_counts?.urgent || 0}</span>{' '}
          <span title="soon">S:{stats.tier_counts?.soon || 0}</span>{' '}
          <span title="normal">N:{stats.tier_counts?.normal || 0}</span>{' '}
          <span title="idle">I:{stats.tier_counts?.idle || 0}</span>
        </span>
        <span
          className={`sys-item ${
            !stats.email_configured
              ? 'sys-warn'
              : stats.email_verified
                ? 'sys-ok'
                : 'sys-warn'
          }`}
          title={stats.email_last_error || ''}
        >
          <b>Email</b>{' '}
          {!stats.email_configured
            ? '○ not configured'
            : stats.email_verified
              ? `● ${stats.email_sent || 0} sent`
              : '⚠ unverified'}
          {stats.email_failed > 0 && ` · ${stats.email_failed} failed`}
        </span>
        <button
          className="sys-btn"
          onClick={handleTestEmail}
          disabled={testingEmail || !stats.email_configured}
          title={!stats.email_configured ? 'Set BREVO_API_KEY, EMAIL_FROM_ADDRESS, EMAIL_TO in .env' : 'Send a test email'}
        >
          {testingEmail ? 'Sending…' : 'Send test email'}
        </button>
      </div>

      <div className="card">
        <div className="card-title">Add Wallets (Bulk — up to 50,000)</div>
        <div className="form-row">
          <div>
            <label htmlFor="phrases">Paste 24-word phrases (one per line)</label>
            <textarea
              id="phrases"
              placeholder={"word1 word2 word3 ... word24\nword1 word2 word3 ... word24"}
              value={phrases}
              onChange={(e) => setPhrases(e.target.value)}
            />
          </div>
          <div>
            <button className="btn btn-primary" onClick={handleAdd} disabled={adding}>
              {adding ? 'Adding…' : 'Add Wallets'}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          Monitored Wallets
          {pagination.pages > 1 && (
            <span className="page-info"> — Page {pagination.page} of {pagination.pages} ({pagination.total} total)</span>
          )}
        </div>
        {wallets.length === 0 ? (
          <div className="empty">No wallets yet</div>
        ) : (
          <>
            <div className="tbl-outer">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Phrase / Address</th>
                    <th>Balance</th>
                    <th>Lockups / Unlock</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {wallets.map((w, i) => (
                    <WalletRow
                      key={w.id}
                      wallet={w}
                      index={(page - 1) * 50 + i}
                      onDelete={handleDelete}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {pagination.pages > 1 && (
              <div className="pagination">
                <button className="btn" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>← Prev</button>
                <span className="page-label">Page {page} / {pagination.pages}</span>
                <button className="btn" onClick={() => setPage(p => Math.min(pagination.pages, p + 1))} disabled={page >= pagination.pages}>Next →</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default Dashboard;
