// Thin wrappers around the server's JSON API.

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error || `${options.method || 'GET'} ${url} failed (${res.status})`);
  }
  return body;
}

export const api = {
  gates: () => request('/api/gates'),
  banners: () => request('/api/banners'),
  createGate: (def) => request('/api/gates', { method: 'POST', body: JSON.stringify(def) }),
  listTracks: () => request('/api/tracks'),
  getTrack: (id) => request(`/api/tracks/${id}`),
  createTrack: (name, data) =>
    request('/api/tracks', { method: 'POST', body: JSON.stringify({ name, data }) }),
  updateTrack: (id, name, data) =>
    request(`/api/tracks/${id}`, { method: 'PUT', body: JSON.stringify({ name, data }) }),
  deleteTrack: (id) => request(`/api/tracks/${id}`, { method: 'DELETE' }),
};
