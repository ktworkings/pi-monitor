import React, { useState, useEffect, useCallback } from 'react';
import { getWallets, addWallets, deleteWallet } from '../api';
import './Dashboard.css';

function formatUnlock(isoStr) {
  if (!isoStr) return <span className="no-unlock">No unlock pending</span>;
  const d = new Date(isoStr);
  const diff = d.getTime() - Date.now();

  if (diff <= 0) return <span className="unlock-now">Claimable NOW</span>;

  const hrs = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  const remaining = hrs > 24 ? `${Math.floor(hrs / 24)}d ${hrs % 24}h` : `${hrs}h ${mins}m`;

  return (
    <>
      <span className="unlock-pending">{d.toLocaleString()}</span>
      <br />
      <span className="unlock-remaining">in {remaining}</span>
    </>
  );
}

function ClaimablesTable({ claimables }) {
  if (!claimables || claimables.length === 0) return null;

  return (
    <table className="cb-table">
      <thead>
        <tr>
          <th>Amount</th>
          <th>Unlock Time</th>
        </tr>
      </thead>
      <tbody>
        {claimables.map((cb) => (
          <tr key={cb.id}>
            <td>{cb.amount} PI</td>
            <td>{cb.unlock_time ? new Date(cb.unlock_time).toLocaleString() : 'Claimable now'}</td>
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

  const handleCopy = () => {
    navigator.clipboard.writeText(wallet.public_key).then(() => {
      setCopyText('Copied!');
      setTimeout(() => setCopyText('copy address'), 1400);
    });
  };

  const handleDelete = () => {
    if (window.confirm('Stop monitoring this wallet?')) {
      onDelete(wallet.id);
    }
  };

  const status = wallet.error ? (
    <span className="status-err">{wallet.error}</span>
  ) : wallet.account_exists ? (
    <span className="status-active">FUNDED</span>
  ) : (
    <span className="status-wait">UNFUNDED</span>
  );

  return (
    <tr>
      <td className="row-num">{index + 1}</td>
      <td>
        <div className="wallet-label">{wallet.phrase_preview || 'unknown'} ...</div>
        <div className="addr-full">{wallet.public_key}</div>
        <button className="copy-link" onClick={handleCopy}>{copyText}</button>
      </td>
      <td>
        <div className="bal-val">{wallet.available_balance || '0.0000000'} PI</div>
        <div className="bal-sub">
          claimable {wallet.claimable_total || '0.0000000'} PI ({cbCount})
        </div>
        {cbCount > 0 && (
          <button className="expand-btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? `Hide ${cbCount} ▴` : `Show ${cbCount} ▾`}
          </button>
        )}
        {expanded && <ClaimablesTable claimables={wallet.claimables} />}
      </td>
      <td>{formatUnlock(wallet.earliest_unlock)}</td>
      <td>
        {status}
        <br />
        <span className="updated-time">
          upd {wallet.updated_at ? new Date(wallet.updated_at).toLocaleTimeString() : '—'}
        </span>
        <br />
        <button className="remove-btn" onClick={handleDelete}>Remove</button>
      </td>
    </tr>
  );
}

function Dashboard({ onLogout }) {
  const [wallets, setWallets] = useState([]);
  const [stats, setStats] = useState({
    total_wallets: 0,
    total_available: '0.0000000',
    total_claimable: '0.0000000',
    total_claimable_count: 0,
  });
  const [phrases, setPhrases] = useState('');
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await getWallets();
      if (data.success) {
        setWallets(data.wallets);
        setStats(data.stats);
      }
    } catch (err) {
      console.error('Failed to refresh wallets:', err);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleAdd = async () => {
    if (!phrases.trim()) {
      alert('Paste one or more phrases');
      return;
    }
    setAdding(true);
    try {
      const data = await addWallets(phrases);
      if (data.success) {
        alert(`Added ${data.added} wallet(s)`);
        setPhrases('');
        refresh();
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
        </div>
        <div className="stat-card">
          <div className="stat-label">Available PI</div>
          <div className="stat-value">{parseFloat(stats.total_available).toFixed(4)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Claimable PI</div>
          <div className="stat-value">{parseFloat(stats.total_claimable).toFixed(4)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Claimable Bals</div>
          <div className="stat-value">{stats.total_claimable_count}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Add Wallets (Bulk)</div>
        <div className="form-row">
          <div>
            <label htmlFor="phrases">Paste multiple 24-word phrases (one per line)</label>
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
        <div className="card-title">Monitored Wallets</div>
        {wallets.length === 0 ? (
          <div className="empty">No wallets yet</div>
        ) : (
          <div className="tbl-outer">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Phrase / Address</th>
                  <th>Balance</th>
                  <th>Unlock Time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {wallets.map((w, i) => (
                  <WalletRow key={w.id} wallet={w} index={i} onDelete={handleDelete} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default Dashboard;
