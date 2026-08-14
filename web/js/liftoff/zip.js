// Minimal ZIP writer, store-only (no compression).
//
// The archive holds two small XML files. Deflate would save a few kilobytes and
// cost a compression library; storing them keeps this dependency-free and the
// result opens natively in Windows Explorer, which is where it is going.
//
// Timestamps are fixed rather than taken from the clock, so exporting the same
// design twice produces an identical archive. That matches the GUIDs, which are
// already deterministic, and makes the output diffable.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// 1980-01-01 00:00:00 in DOS format — the earliest the format can express.
const DOS_TIME = 0;
const DOS_DATE = 33;

/**
 * Build a zip from [{name, text}, ...]. Names use forward slashes and may
 * include directories; no explicit directory entries are emitted, which every
 * extractor handles.
 *
 * @returns {Blob}
 */
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const dataBytes = enc.encode(f.text);
    const crc = crc32(dataBytes);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // local file header signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // method: stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);   // compressed size
    lv.setUint32(22, dataBytes.length, true);   // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // extra field length
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);   // central directory signature
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);           // extra
    cv.setUint16(32, 0, true);           // comment
    cv.setUint16(34, 0, true);           // disk number
    cv.setUint16(36, 0, true);           // internal attributes
    cv.setUint32(38, 0, true);           // external attributes
    cv.setUint32(42, offset, true);      // offset of local header
    cd.set(nameBytes, 46);

    parts.push(local, dataBytes);
    central.push(cd);
    offset += local.length + dataBytes.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);     // end of central directory
  ev.setUint16(8, files.length, true);   // entries on this disk
  ev.setUint16(10, files.length, true);  // total entries
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);        // central directory offset
  ev.setUint16(20, 0, true);             // comment length

  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
