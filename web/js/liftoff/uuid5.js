// Deterministic UUIDv5, byte-compatible with Python's uuid.uuid5.
//
// Track identity is uuid5(NS, "track:<id>:<scale>"), so exporting the same
// design twice must produce the same GUID -- that is what makes a re-export
// overwrite the previous copy in Liftoff instead of adding another entry to an
// already crowded track list. It therefore has to agree with the Python
// converter exactly, not merely be stable in itself.
//
// SHA-1 is implemented here rather than taken from crypto.subtle: that API is
// only available in a secure context, so it works on localhost but silently
// disappears the moment the designer is served over plain http from a LAN
// address. It is also async, which would make the whole export chain async for
// no benefit. Ninety lines avoids both problems.

function sha1(bytes) {
  const ml = bytes.length;
  // Pad to a multiple of 64 with 0x80, zeros, then the bit length as 64-bit BE.
  const withPad = new Uint8Array((((ml + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[ml] = 0x80;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 4, ml << 3, false);
  view.setUint32(withPad.length - 8, (ml >>> 29) & 0xffffffff, false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe,
      h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  const rol = (n, s) => (n << s) | (n >>> (32 - s));

  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rol(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }

  const out = new Uint8Array(20);
  new DataView(out.buffer).setInt32(0, h0, false);
  new DataView(out.buffer).setInt32(4, h1, false);
  new DataView(out.buffer).setInt32(8, h2, false);
  new DataView(out.buffer).setInt32(12, h3, false);
  new DataView(out.buffer).setInt32(16, h4, false);
  return out;
}

/** "6f1d2c84-5a3b-..." -> the 16 raw bytes. */
function parseUuid(str) {
  const hex = str.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function formatUuid(b) {
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
         `${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** uuid5(namespace, name) — namespace is a UUID string, name a JS string. */
export function uuid5(namespace, name) {
  const nsBytes = parseUuid(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const msg = new Uint8Array(nsBytes.length + nameBytes.length);
  msg.set(nsBytes);
  msg.set(nameBytes, nsBytes.length);

  const h = sha1(msg).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;   // version 5
  h[8] = (h[8] & 0x3f) | 0x80;   // RFC 4122 variant
  return formatUuid(h);
}
