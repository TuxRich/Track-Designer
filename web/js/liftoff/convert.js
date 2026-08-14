// Turn a designer track into a Liftoff track + race.
//
// Port of tools/convert.py. The geometry decisions below were settled by
// flying the results, not by reading documentation, so the reasoning is kept
// with them.
//
// Why the scale factor
// --------------------
// Designer tracks are real whoop courses: 5-10 m rooms with 0.5-0.75 m gates.
// The smallest gate prop in Liftoff is FliteTestSmallGateGremlin01 at ~1.10 m,
// so a true 1:1 rebuild carries a mean aperture error of 107% -- every gate
// roughly twice the size it should be. Scaling is not a preference, it is
// forced. x2 lands gates on 1.52 m, exactly what a real 5" course uses.
//
// Nothing is ever scaled
// ----------------------
// <scale> is ignored on plain TrackBlueprintFlag, so every piece of geometry is
// chosen at its native size and the floor is tiled rather than stretched.

import { uuid5 } from './uuid5.js';
import * as cat from './catalog.js';
import { Instances, checkpoint, flag, raceXml, spawnpoint, trackXml } from './xml.js';

// Handedness.
//
// The designer's plan view is right-handed (+x right, +z down-screen); Unity is
// left-handed. Mapping x->x and z->z directly carries the handedness across
// unchanged, which mirrors the whole course -- confirmed in the air: Cream
// First #1 turned right after gate 1 where the designer turns left.
//
// Mirroring x also negates every heading, which cancels the
// anticlockwise-to-clockwise flip already needed, leaving YAW_SIGN at +1. The
// two must change together, so they derive from one flag.
export const MIRROR_X = true;
const YAW_SIGN = MIRROR_X ? 1.0 : -1.0;

const NS = '6f1d2c84-5a3b-4e97-b0c2-7d9e4f8a1b60';
const FLOOR_TILE = 'DrawingBoardCube10mx10m03';  // bottom-pivot: at y=-10 its top is y=0
// BannerStructure01 is the scaffolding FRAME that holds a banner, not a banner.
const BANNER = 'Banner5x5mLiftoffCyan01';
const FURNITURE = 'DrawingBoardCube1mx1m01';
const SPAWN_SETBACK = 6.0;
export const POLE_TRIGGER_MARGIN = 4.0;

// Classify by SHAPE, not typeId -- typeId is an open set, minted at runtime by
// the "+ New gate type" button, so any table keyed on it goes stale. `shape` is
// closed and every gate definition carries innerSize, the real aperture.
const SHAPES = {
  square: ['gate', 'square'],
  hex: ['gate', 'octagon'],
  circle: ['gate', 'hoop'],
  cube: ['gate', 'cube'],
  pole: ['obstacle', 'pole'],
  banner: ['decoration', 'banner'],
  table: ['decoration', 'table'],
  chair: ['decoration', 'chair'],
};

/** What a designer gate is, in Liftoff terms. */
function classify(gate, defs) {
  const d = defs && defs[gate.typeId];
  if (d && SHAPES[d.shape]) {
    const [role, kind] = SHAPES[d.shape];
    return { role, size: Number(d.innerSize) || 0.75, kind, known: true };
  }
  return { role: 'gate', size: 0.75, kind: 'square', known: false };
}

/** Deterministic GUIDs. Scale is part of the identity, so x2 and x4 coexist. */
export function guids(trackId, scale) {
  const s = String(scale);
  return [uuid5(NS, `track:${trackId}:${s}`), uuid5(NS, `race:${trackId}:${s}`)];
}

/**
 * Convert an in-memory designer document.
 *
 * `src` is {id, name, data:{arena, gates}}; `defs` is {typeId: definition} as
 * returned by GET /api/gates. Returns the two XML documents, their GUIDs, and
 * a per-gate summary for the UI.
 */
export function convert(src, {
  scale = 2.0,
  environment = 'TheDrawingBoard',
  poleTrigger = POLE_TRIGGER_MARGIN,
  defs = null,
} = {}) {
  const data = src.data;
  const a = data.arena;
  const w = a.w * scale, d = a.d * scale;
  const ox = -w / 2.0, oz = -d / 2.0;   // centre the arena on the world origin

  const bp = [];
  const ids = new Instances();
  const add = (s) => bp.push(s);

  // Floor. A 10 m cube is bottom-pivot, so at y=-10 its top face is exactly
  // y=0. Tiled rather than stretched, because <scale> does nothing on a flag.
  const nx = Math.ceil(w / 10.0), nz = Math.ceil(d / 10.0);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      add(flag(FLOOR_TILE, ids.take(), [ox + i * 10 + 5, -10, oz + j * 10 + 5]));
    }
  }

  const kinds = data.gates.map((g) => classify(g, defs));
  const unknown = [...new Set(data.gates.filter((g, i) => !kinds[i].known)
    .map((g) => g.typeId))].sort();

  // Gates are chosen for the track as a whole, not one at a time: whether a
  // shape survives depends on how it compares with its neighbours.
  const plan = cat.planGates(
    kinds.filter((k) => k.role === 'gate').map((k) => [k.size * scale, k.kind]));
  let planAt = 0;

  const world = (g) => [
    MIRROR_X ? -(ox + g.x * scale) : ox + g.x * scale,
    oz + g.z * scale,
  ];

  // World positions of the course elements, in order. Needed before emitting,
  // because a pole's trigger must be squared to the direction of travel and
  // that is only knowable from its neighbours.
  const course = [];
  data.gates.forEach((g, i) => {
    if (g.prop || kinds[i].role === 'decoration') return;
    course.push(world(g));
  });

  /**
   * Heading through course element i, from its neighbours.
   *
   * A pole is rotationally symmetric, so its own rotY says nothing about which
   * way you pass it -- squaring the trigger to that angle left the plane
   * edge-on to the flight path and effectively unhittable.
   */
  function travelYaw(i) {
    if (course.length < 2) return 0.0;
    const p = i > 0 ? course[i - 1] : course[i];
    const q = i + 1 < course.length ? course[i + 1] : course[i];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    if (dx === 0 && dz === 0) return 0.0;
    return Math.atan2(dx, dz) * 180 / Math.PI;  // Unity forward = (sin y, cos y)
  }

  const order = [], summary = [];
  let first = null, ci = -1;

  data.gates.forEach((g, i) => {
    const { role, size, kind } = kinds[i];
    const x = MIRROR_X ? -(ox + g.x * scale) : ox + g.x * scale;
    const z = oz + g.z * scale;
    // `height` is overloaded in the designer: a mount offset for gates, but for
    // furniture it is the item's OWN height, so a table with height 0.7 stands
    // on the floor rather than floating 1.4 m up at x2.
    const y = (kind === 'table' || kind === 'chair') ? 0.0 : g.height * scale;
    const yaw = (g.rotY * 180 / Math.PI) * YAW_SIGN;
    const target = size * scale;
    if (!g.prop && role !== 'decoration') ci += 1;

    if (role === 'gate') {
      const [item, gw, gh, sub] = plan[planAt++];
      add(flag(item, ids.take(), [x, y, z], [0, yaw, 0]));
      summary.push({
        typeId: g.typeId, role, want: target, got: gw, item,
        err: Math.abs(gw - target) / target * 100, substituted: sub,
      });
      if (!g.prop) {
        // Trigger sized to the gate, not a fixed box. A 2 m checkpoint in a 3 m
        // gate leaves a ring you can fly through cleanly and still miss.
        const [, sc] = cat.pickCheckpoint(gw, gh);
        const cid = ids.take();
        add(checkpoint(cid, [x, y + gh / 2.0, z], [0, yaw, 0], sc));
        order.push(cid);
        if (first === null) first = [x, y, z, yaw];
      }
    } else if (role === 'obstacle') {
      const [item, native] = cat.pickPole(target);
      add(flag(item, ids.take(), [x, y, z], [0, yaw, 0]));
      const row = { typeId: g.typeId, role, want: target, got: native, item };
      if (!g.prop) {
        // Poles are course elements, not scenery -- the designer numbers them
        // in the sequence. You fly AROUND one, so the trigger is a plane
        // centred on it, wide enough to catch a pass down either side. These
        // overlap their neighbours, which is safe: race passages are
        // sequential, so a checkpoint only counts once its predecessor has.
        const tyaw = travelYaw(ci);
        const tw = native + poleTrigger;
        const cid = ids.take();
        add(checkpoint(cid, [x, y + native / 2.0, z], [0, tyaw, 0], [tw, tw, 0.2]));
        order.push(cid);
        if (first === null) first = [x, y, z, tyaw];
        row.trigger = tw;
        row.triggerYaw = tyaw;
      }
      summary.push(row);
    } else {
      // A 5 m banner sheet standing in for a 1.2 m table was absurd, and Table
      // Flow is four fifths tables. Furniture becomes a 1 m cube instead.
      const item = (kind === 'table' || kind === 'chair') ? FURNITURE : BANNER;
      add(flag(item, ids.take(), [x, y, z], [0, yaw, 0]));
      summary.push({ typeId: g.typeId, role, kind, item });
    }
  });

  // Spawn on the run-in to the first gate, facing it. A gate at yaw t has its
  // normal along local +Z, which Unity's left-handed Y-rotation maps to
  // (sin t, 0, cos t); backing off along -normal puts the drone on the
  // approach side, pointing at the gate.
  const spawn = ids.take();
  if (first) {
    const [gx, , gz, gyaw] = first;
    const t = gyaw * Math.PI / 180;
    const back = SPAWN_SETBACK * scale / 4.0;
    add(spawnpoint(spawn,
      [gx - Math.sin(t) * back, 0.5, gz - Math.cos(t) * back], [0, gyaw, 0]));
  } else {
    add(spawnpoint(spawn, [0, 0.5, oz - 4]));
  }

  const [tg, rg] = guids(src.id, scale);
  const name = `${src.name} (x${scale})`;
  const track = trackXml(tg, name, bp, environment, true,
    `From designer ${src.id}, scaled x${scale}. Arena ${w}x${d}m.`);
  const race = raceXml(rg, name, tg, order, spawn, 1);

  return {
    track, race, trackGuid: tg, raceGuid: rg, name,
    checkpoints: order.length, arena: [w, d], summary, unknown,
  };
}
