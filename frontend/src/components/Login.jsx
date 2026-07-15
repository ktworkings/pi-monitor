import React, { useState } from 'react';
import { login } from '../api';
import './Login.css';

function Login({ onLogin }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!user || !pass) {
      setError('Enter username and password');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await login(user, pass);
      if (data.success) {
        onLogin();
      } else {
        setError(data.error || 'Login failed');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-title">◎ Pi Wallet Monitor</div>
        <div className="form-group">
          <label htmlFor="user">Username</label>
          <input
            id="user"
            type="text"
            placeholder="admin"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="pass">Password</label>
          <input
            id="pass"
            type="password"
            placeholder="••••••"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </div>
        <button className="login-btn" type="submit" disabled={loading}>
          {loading ? 'Signing In…' : 'Sign In'}
        </button>
        {error && <div className="login-error">{error}</div>}
      </form>
    </div>
  );
}

export default Login;
