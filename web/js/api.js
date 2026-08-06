// Thin wrappers around the server's JSON API.

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || `${options.method || 'GET'} ${url} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Password (when given) authorizes edits/deletes of protected tracks via the
// X-Track-Password header; it can be the track's own password or the admin one.
const pwHeader = (password) => (password ? { 'X-Track-Password': password } : {});

export const api = {
  gates: () => request('/api/gates'),
  banners: () => request('/api/banners'),
  createGate: (def) => request('/api/gates', { method: 'POST', body: JSON.stringify(def) }),
  listTracks: () => request('/api/tracks'),
  getTrack: (id) => request(`/api/tracks/${id}`),
  createTrack: (name, data, password) =>
    request('/api/tracks', { method: 'POST', body: JSON.stringify({ name, data, password }) }),
  updateTrack: (id, name, data, password) =>
    request(`/api/tracks/${id}`, { method: 'PUT', body: JSON.stringify({ name, data }), headers: pwHeader(password) }),
  deleteTrack: (id, password) =>
    request(`/api/tracks/${id}`, { method: 'DELETE', headers: pwHeader(password) }),
};
