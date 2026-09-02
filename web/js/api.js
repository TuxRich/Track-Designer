// Thin wrappers around the server's JSON API.

async function request(url, options = {}) {
  const res = await fetch(url, {
    // Never read the API from the browser cache — a stale track after a save
    // makes the save look like it was lost (belt-and-braces with the server's
    // no-store headers, in case a proxy strips them).
    cache: 'no-store',
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
  // A password here also reveals the private (unreleased) tracks it unlocks.
  listTracks: (password) => request('/api/tracks', { headers: pwHeader(password) }),
  getTrack: (id, password) => request(`/api/tracks/${id}`, { headers: pwHeader(password) }),
  createTrack: (name, data, password, isPrivate) =>
    request('/api/tracks', {
      method: 'POST',
      body: JSON.stringify({ name, data, password, private: !!isPrivate }),
    }),
  // Release a track (private:false) or pull it back, without resending data.
  setTrackPrivacy: (id, isPrivate, password) =>
    request(`/api/tracks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ private: !!isPrivate }),
      headers: pwHeader(password),
    }),
  updateTrack: (id, name, data, password) =>
    request(`/api/tracks/${id}`, { method: 'PUT', body: JSON.stringify({ name, data }), headers: pwHeader(password) }),
  deleteTrack: (id, password) =>
    request(`/api/tracks/${id}`, { method: 'DELETE', headers: pwHeader(password) }),
};
