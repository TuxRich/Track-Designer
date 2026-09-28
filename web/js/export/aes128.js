// Minimal AES-128 encryption (FIPS-197), ECB mode with PKCS#7 padding.
//
// Only needed because Velocidrone's .trk files are AES-128-ECB and Web Crypto
// deliberately offers no ECB mode. Encrypt-only: the designer never reads
// .trk files back.

const SBOX = new Uint8Array(256);
{
  // Build the S-box from the GF(2^8) inverse plus the affine transform, rather
  // than pasting a 256-entry table.
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0); // p *= 3
    q ^= q << 1; q ^= q << 2; q ^= q << 4;             // q /= 3
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const rotl = (x, s) => ((x << s) | (x >> (8 - s))) & 0xff;
    SBOX[p] = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63;
  } while (p !== 1);
  SBOX[0] = 0x63;
}

const xtime = (b) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;

function expandKey(key) {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) {
      [t0, t1, t2, t3] = [SBOX[t1] ^ rcon, SBOX[t2], SBOX[t3], SBOX[t0]];
      rcon = xtime(rcon);
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

function encryptBlock(s, rk) {
  for (let i = 0; i < 16; i++) s[i] ^= rk[i];
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    // ShiftRows (state is column-major: byte i is row i%4, column i>>2).
    let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
    if (round < 10) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
        const all = a0 ^ a1 ^ a2 ^ a3;
        s[c] ^= all ^ xtime(a0 ^ a1);
        s[c + 1] ^= all ^ xtime(a1 ^ a2);
        s[c + 2] ^= all ^ xtime(a2 ^ a3);
        s[c + 3] ^= all ^ xtime(a3 ^ a0);
      }
    }
    const k = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= rk[k + i];
  }
}

/** AES-128-ECB encrypt `data` (Uint8Array) under a 16-byte `key`, PKCS#7 padded. */
export function aes128EcbEncrypt(data, key) {
  if (key.length !== 16) throw new Error('AES-128 needs a 16-byte key');
  const rk = expandKey(key);
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  for (let i = 0; i < out.length; i += 16) encryptBlock(out.subarray(i, i + 16), rk);
  return out;
}
