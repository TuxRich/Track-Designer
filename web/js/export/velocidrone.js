// Turn a designer track into a Velocidrone .trk file, set in the Sports Hall.
//
// The .trk format
// ---------------
// base64( AES-128-ECB( PKCS7( "<sceneId>\n<name>\n<json>" ))) with the key
// "Velocidr" + "rdicoleV". The JSON is {gates:[...], barriers:[...]}; every
// item is {prefab, trans:{pos, rot, scale}}, and gates add their lap order.
// This is the same format FPVTrackside writes, and what Velocidrone's Track
// Editor -> "Import Track" reads from the Documents folder.
//
//   pos    integer centimetres, Unity world space (left-handed, Y up)
//   rot    quaternion as integers x1000, in (w, x, y, z) order
//   scale  integer percent per axis
//
// Prefab frames
// -------------
// The saved rotation and scale REPLACE the prefab's own root transform rather
// than adding to it — measured against real tracks, where the MultiGP gates'
// stored yaw only lines up with the racing line under that reading. Many
// prefabs are authored with a rotated, scaled root (the micro neon gates are
// pitched -90 degrees about X and scaled to 20%), so each prefab's root
// transform is folded back in here. Composed like that, every gate below
// stands upright with its base on its pivot, its aperture centred on the pivot
// and its fly-through axis along +X; the block is a base-pivot 2 m cube.
//
// Sizes and root transforms were measured from Velocidrone 1.16's asset
// bundles; the Sports Hall bounds from its scene (the hall shell mesh).

import { aes128EcbEncrypt } from './aes128.js';

const KEY = new TextEncoder().encode('VelocidrrdicoleV');

// Pitched -90 degrees about X, as (x, y, z, w).
const PITCH_DOWN = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const IDENTITY = [0, 0, 0, 1];

// native: size in metres at 100% scale (gates: outer width/height).
const NEON_SQUARE = { B: 752, G: 753, P: 754, R: 755 };
const NEON_CIRCLE = { B: 748, G: 749, P: 750, R: 751 };
const NEON = { root: PITCH_DOWN, native: 2.0 };
const NEON_ROUND = { root: PITCH_DOWN, native: 2.03 };
const FLAG = { prefab: 773, name: 'BetaFPVFlag', root: PITCH_DOWN, native: 1.368 };
const BLOCK = { prefab: 54, name: 'DefaultCubeBarrier', root: IDENTITY, native: 2.0 };

export const SCENES = {
  sportsHall: {
    id: 21,
    name: 'Sports Hall',
    // Inside faces of the hall shell. The floor is 7 cm above world zero.
    minX: 4.97, maxX: 28.12, minZ: -20.9, maxZ: 19.86,
    floorY: 0.07, ceilingY: 10.6,
  },
};

export const SCALES = [1, 1.5, 2, 3, 4];

// ---------------------------------------------------------------- maths ---

/** Hamilton product of two (x, y, z, w) quaternions. */
function qmul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

const yawQuat = (deg) => {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
};

// About Z: +90 turns an upright gate's fly-through axis (+X) to point up.
const rollQuat = (deg) => {
  const h = (deg * Math.PI) / 360;
  return [0, 0, Math.sin(h), Math.cos(h)];
};

/** Rotate vector v by (x, y, z, w) quaternion q. */
function qrot(q, v) {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

// Outward face normals of a cube gate, in the designer's frame (gates.js).
const CUBE_NORMALS = {
  front: [0, 0, -1],
  back: [0, 0, 1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
};

// A cube pass is "in>out" (e.g. "top>left"). Same rules as normalizeCubeDir
// in gates.js, copied so the exporter doesn't pull in three.js: older tracks
// saved single keywords.
const LEGACY_CUBE_DIRS = {
  forward: 'front>back', back: 'back>front', right: 'left>right',
  left: 'right>left', down: 'top>bottom', up: 'bottom>top',
};
function cubePass(dir) {
  const [a, b] = (dir?.includes('>') ? dir : LEGACY_CUBE_DIRS[dir] || 'front>back').split('>');
  return [CUBE_NORMALS[a] ? a : 'front', CUBE_NORMALS[b] ? b : 'back'];
}

// Stored as (w, x, y, z) x1000. The sign of a quaternion is free, so keep w
// non-negative for stable output.
function packRot(q) {
  const s = q[3] < 0 ? -1 : 1;
  return [q[3], q[0], q[1], q[2]].map((v) => Math.round(v * s * 1000) || 0);
}

const cm = (m) => Math.round(m * 100);
const pct = (v) => Math.max(1, Math.round(v * 100));

// Nearest of Velocidrone's four neon colours to a designer colour, by hue.
function neonColour(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 'R';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 0.1) return 'B'; // grey or white: no hue to match
  let h;
  if (max === r) h = ((g - b) / (max - min) + 6) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h *= 60;
  const hues = { R: 0, G: 120, B: 220, P: 285 };
  let best = 'R', bestD = Infinity;
  for (const [k, v] of Object.entries(hues)) {
    const d = Math.min(Math.abs(h - v), 360 - Math.abs(h - v));
    if (d < bestD) { best = k; bestD = d; }
  }
  return best;
}

// ------------------------------------------------------------ placement ---

/**
 * Where a scaled arena goes in the scene. It is centred in the hall and, when
 * that fits better, turned 90 degrees so its long side runs down the hall's.
 */
export function layout(arena, scale, scene = SCENES.sportsHall) {
  const w = arena.w * scale, d = arena.d * scale;
  const hallW = scene.maxX - scene.minX, hallD = scene.maxZ - scene.minZ;
  const turn = (w > d) !== (hallW > hallD);
  const [spanX, spanZ] = turn ? [d, w] : [w, d];
  return {
    turn,
    size: [w, d],
    fits: spanX <= hallW && spanZ <= hallD,
    centre: [(scene.minX + scene.maxX) / 2, (scene.minZ + scene.maxZ) / 2],
  };
}

/**
 * Convert an in-memory designer document.
 *
 * `src` is {name, data:{arena, gates}}; `defs` maps typeId to the gate
 * definition. Returns the .trk JSON plus a per-gate summary for the dialog.
 */
export function convert(src, defs, { scale = 1, scene = SCENES.sportsHall } = {}) {
  const { arena, gates: list } = src.data;
  const place = layout(arena, scale, scene);
  const [cx, cz] = place.centre;
  const turnDeg = place.turn ? 90 : 0;
  const turnQ = yawQuat(turnDeg);
  const cosT = place.turn ? 0 : 1, sinT = place.turn ? 1 : 0;

  // Designer space is right-handed and Unity's is left-handed; mirroring X
  // carries the course across without flipping it. A mirror also reverses
  // every rotation, so a designer yaw of t becomes -t in Unity.
  const toWorld = (x, y, z) => {
    const ux = -(x - arena.w / 2) * scale;
    const uz = (z - arena.d / 2) * scale;
    return [
      cx + ux * cosT + uz * sinT,
      scene.floorY + y * scale,
      cz - ux * sinT + uz * cosT,
    ];
  };

  // `q` is the item's full Unity rotation before the prefab's own root
  // rotation, which the saved rotation replaces and so is folded back in.
  const placed = (prefab, root, pos, q, scaleVec) => ({
    prefab,
    trans: {
      pos: pos.map(cm),
      rot: packRot(qmul(q, root)),
      scale: scaleVec.map(pct),
    },
  });
  // `yaw` is the item's yaw in Unity, before the whole-layout turn.
  const item = (prefab, root, pos, yaw, scaleVec) =>
    placed(prefab, root, pos, qmul(turnQ, yawQuat(yaw)), scaleVec);

  // One face of a cube gate, as a neon square gate. Faces are named as in the
  // designer (front = -Z, left = -X, top = +Y in the cube's own frame). The
  // mirror into Unity flips the cube's local X, and a designer yaw of t is
  // -t in Unity, as for everything else.
  const cubeFace = (g, face, prefab, outer) => {
    const [nx, ny, nz] = CUBE_NORMALS[face];
    const n = [-nx, ny, nz]; // cube-local, in Unity's handedness
    // Turn the upright gate (fly-through +X, base on its pivot) so it faces n.
    const qFace = ny ? rollQuat(90) : nz ? yawQuat(-90) : IDENTITY;
    const h = outer / 2;
    const centre = [n[0] * h, h + n[1] * h, n[2] * h];
    const up = qrot(qFace, [0, h, 0]); // pivot to aperture centre
    const local = centre.map((v, i) => (v - up[i]) * scale);
    const qCube = qmul(turnQ, yawQuat(-deg(g.rotY)));
    const off = qrot(qCube, local);
    const base = toWorld(g.x, g.height || 0, g.z);
    const k = (outer * scale) / NEON.native;
    return placed(prefab, NEON.root, base.map((v, i) => v + off[i]), qmul(qCube, qFace), [k, k, k]);
  };

  // A cube may be flown through several times (one designer entry per pass),
  // but its frame should only be built once. Collect, per cube, the faces any
  // pass uses as race gates; the other faces are built as scenery.
  const cubeKey = (g) => [g.typeId, g.x, g.z, g.height || 0, g.rotY].join('|');
  const raceFaces = new Map();
  for (const g of list) {
    if (defs[g.typeId]?.shape !== 'cube' || g.prop) continue;
    const faces = raceFaces.get(cubeKey(g)) || new Set();
    for (const f of cubePass(g.dir)) faces.add(f);
    raceFaces.set(cubeKey(g), faces);
  }
  const builtCubes = new Set();

  // A box of the given size, built from the block prefab, in a designer
  // object's local frame: (lx, lz) from its centre, standing on height ly.
  const block = (g, lx, ly, lz, sx, sy, sz) => {
    const c = Math.cos(g.rotY), s = Math.sin(g.rotY);
    const x = g.x + lx * c + lz * s;
    const z = g.z - lx * s + lz * c;
    return item(BLOCK.prefab, BLOCK.root, toWorld(x, ly, z), -deg(g.rotY),
      [sx * scale / BLOCK.native, sy * scale / BLOCK.native, sz * scale / BLOCK.native]);
  };

  const gates = [], barriers = [], summary = [];
  const unknown = new Set();
  let order = 0;
  // Highest point of anything placed, in designer metres, so the dialog can
  // warn when a scaled-up track pokes through the ceiling. (The arena's own
  // height is only a drawing aid, so it isn't what's checked.)
  let top = 0;
  const reach = (y) => { top = Math.max(top, y); };

  for (const g of list) {
    const def = defs[g.typeId];
    if (!def) { unknown.add(g.typeId); continue; }
    const tube = def.tubeWidth || 0;
    const outer = def.innerSize + 2 * tube;
    const race = !g.prop;

    if (def.shape === 'cube') {
      // A cube is six square frames, one per face, so it has a top and a
      // bottom and you fly through its sides. The pass's entry and exit
      // faces are race gates, in that order; the rest are scenery.
      const colour = neonColour(def.color);
      const prefab = NEON_SQUARE[colour];
      const [inFace, outFace] = cubePass(g.dir);
      if (race) {
        addCourse(cubeFace(g, inFace, prefab, outer), true);
        addCourse(cubeFace(g, outFace, prefab, outer), true);
      }
      const key = cubeKey(g);
      if (!builtCubes.has(key)) {
        builtCubes.add(key);
        const used = raceFaces.get(key) || new Set();
        for (const face of Object.keys(CUBE_NORMALS)) {
          if (!used.has(face)) barriers.push(cubeFace(g, face, prefab, outer));
        }
      }
      reach((g.height || 0) + outer);
      summary.push({
        typeId: g.typeId, role: race ? 'gate' : 'prop',
        vd: `6 × Neon square ${colour}`,
        size: outer * scale,
        note: race ? `gates on ${inFace} then ${outFace}` : 'cube frame',
      });
    } else if (['square', 'hex', 'circle'].includes(def.shape)) {
      const round = def.shape === 'circle' || def.shape === 'hex';
      const colour = neonColour(def.color);
      const prefab = (round ? NEON_CIRCLE : NEON_SQUARE)[colour];
      const spec = round ? NEON_ROUND : NEON;
      const k = (outer * scale) / spec.native;
      // Gates fly through along +X; the designer's fly-through axis is its
      // local Z, a quarter turn round from X.
      const it = item(prefab, spec.root, toWorld(g.x, g.height || 0, g.z),
        -deg(g.rotY) - 90, [k, k, k]);
      addCourse(it, race);
      reach((g.height || 0) + outer);
      summary.push({
        typeId: g.typeId, role: race ? 'gate' : 'prop',
        vd: `${round ? 'Neon circle' : 'Neon square'} ${colour}`,
        size: outer * scale,
        note: def.shape === 'hex' ? 'hex as a circle' : '',
      });
    } else if (def.shape === 'pole') {
      const k = (def.innerSize * scale) / FLAG.native;
      const it = item(FLAG.prefab, FLAG.root, toWorld(g.x, g.height || 0, g.z),
        -deg(g.rotY) - 90, [k, k, k]);
      addCourse(it, race);
      reach((g.height || 0) + def.innerSize);
      summary.push({ typeId: g.typeId, role: race ? 'flag' : 'prop', vd: 'BetaFPV flag', size: def.innerSize * scale, note: '' });
    } else if (def.shape === 'banner') {
      // A solid panel on the floor (or its mount height). Velocidrone can't
      // carry the artwork, so it's a plain block.
      const thick = Math.max(0.03, tube);
      barriers.push(block(g, 0, g.height || 0, 0, def.innerSize, def.depth || 0.6, thick));
      reach((g.height || 0) + (def.depth || 0.6));
      summary.push({ typeId: g.typeId, role: 'scenery', vd: 'block panel', size: def.innerSize * scale, note: 'no artwork' });
    } else if (def.shape === 'table' || def.shape === 'chair') {
      // Rebuilt from blocks — a top and four legs — so you can still fly
      // under a table. `height` is the furniture's own height here.
      const W = def.innerSize, D = def.depth || def.innerSize;
      const H = g.height || def.defaultHeight || 0.7;
      const t = Math.max(0.02, tube || 0.05);
      const legH = Math.max(0.02, H - t);
      const inset = t / 2 + 0.03;
      const xe = W / 2 - inset, ze = D / 2 - inset;
      barriers.push(block(g, 0, H - t, 0, W, t, D));
      for (const sx of [-xe, xe]) for (const sz of [-ze, ze]) barriers.push(block(g, sx, 0, sz, t, legH, t));
      if (def.shape === 'chair') {
        // Back posts and panel on the rear (-Z) edge, as the designer draws it.
        const rise = Math.max(0.35, H);
        for (const sx of [-xe, xe]) barriers.push(block(g, sx, H, -ze, t, rise, t));
        const panelH = rise * 0.55;
        barriers.push(block(g, 0, H + rise - panelH - 0.03, -ze, W - 2 * inset, panelH, t * 0.8));
      }
      reach(def.shape === 'chair' ? H + Math.max(0.35, H) : H);
      summary.push({ typeId: g.typeId, role: 'scenery', vd: 'blocks', size: W * scale, note: '' });
    } else {
      unknown.add(g.typeId);
    }
  }

  function addCourse(it, race) {
    if (!race) { barriers.push(it); return; }
    const first = order === 0;
    gates.push({ ...it, gate: order++, start: first, finish: first, lap1only: false });
  }

  const tooTall = top * scale > scene.ceilingY - scene.floorY;
  return {
    json: { gates, barriers },
    summary,
    unknown: [...unknown].sort(),
    gates: gates.length,
    objects: gates.length + barriers.length,
    place: { ...place, tooTall, fits: place.fits && !tooTall },
    scene,
  };
}

const deg = (rad) => (rad * 180) / Math.PI;

// ------------------------------------------------------------- the file ---

// Velocidrone lists imported tracks by this name; keep it to the characters
// its own exports use.
export function safeName(name) {
  return (name || 'Track').replace(/[^a-zA-Z0-9 -]/g, '').trim().slice(0, 60) || 'Track';
}

/** The encrypted .trk text for a converted track. */
export function encodeTrk(sceneId, name, json) {
  const plain = `${sceneId}\n${safeName(name)}\n${JSON.stringify(json)}`;
  const bytes = aes128EcbEncrypt(new TextEncoder().encode(plain), KEY);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Build the .trk for a designer document. */
export function buildTrk(src, defs, opts) {
  const r = convert(src, defs, opts);
  const scaleTag = opts?.scale && opts.scale !== 1 ? ` x${opts.scale}` : '';
  const name = safeName(`${src.name}${scaleTag}`);
  return {
    ...r,
    name,
    filename: `${name}.trk`,
    text: encodeTrk(r.scene.id, name, r.json),
  };
}
