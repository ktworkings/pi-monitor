const API_BASE = '';

export function getToken() {
  return localStorage.getItem('authToken');
}

export function setToken(token) {
  localStorage.setItem('authToken', token);
}

export function clearToken() {
  localStorage.removeItem('authToken');
}

async function request(url, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  };

  const res = await fetch(`${API_BASE}${url}`, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error('unauthorized');
  }

  return res.json();
}

export async function login(user, pass) {
  const data = await request('/login', {
    method: 'POST',
    body: JSON.stringify({ user, pass }),
  });
  if (data.success) {
    setToken(data.token);
  }
  return data;
}

export async function verifyToken() {
  return request('/api/verify-token');
}

export async function getWallets() {
  return request('/api/wallets');
}

export async function addWallets(phrases) {
  return request('/api/wallets', {
    method: 'POST',
    body: JSON.stringify({ phrases }),
  });
}

export async function deleteWallet(id) {
  return request(`/api/wallets/${id}`, { method: 'DELETE' });
}
