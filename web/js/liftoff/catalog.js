// Real Liftoff gate props, and how a designer gate is matched to one.
//
// Port of tools/gate_catalog.py. The prop catalogue is not readable from the
// game files -- it lives in compressed Addressables bundles -- so these entries
// were mined from 3,369 downloaded Steam Workshop tracks, whose names often
// carry real dimensions (GemfanDroneRacingGate152x152cm01 is 1.52 m). The
// mining half is offline analysis and is deliberately not ported; only the
// distilled result is needed at export time.
//
// Entries are [itemID, width_m, height_m, kind].

export const GATES = [
  // The smallest gate in the game, and easy to miss: its name carries no
  // dimensions, so a name-parsing sweep skips it entirely. Measured at ~1.10 m
  // from nearest-neighbour minima.
  ['FliteTestSmallGateGremlin01', 1.10, 1.10, 'square'],
  ['GemfanDroneRacingGate152x152cm01', 1.52, 1.52, 'square'],
  ['OctagonGate200x200cmGeneric01', 2.00, 2.00, 'octagon'],
  ['GenericGate200x250cm01', 2.00, 2.50, 'square'],
  ['AirgateSmall150H210B01LuGusStudios01', 2.10, 1.50, 'square'],
  // Kept out of the square pool so it is never chosen mid-course; a
  // start/finish arch in the middle of a lap reads as a wrong turn.
  ['NexxbladesStartFinish250x300cm01', 2.50, 3.00, 'startfinish'],
  ['LightGate300x220cmVarBlue01', 3.00, 2.20, 'square'],
  ['AirgateBig240H300B01luGusStudios01', 3.00, 2.40, 'square'],
];

export const HOOPS = [
  ['ASLLightHoopGate01', 2.00, 2.00, 'hoop'],
  ['GenericHoopGate01', 2.00, 2.00, 'hoop'],
];

// GemfanAirGatePopUpCube01 is 1.45 m, not the 2.00 m first assumed. Two
// independent measures agree: the minimum nearest-neighbour distance over 6,206
// pairs is 1.45 m, and flush vertical stacks step by 1.44 m. The 2.00 m mode in
// the spacing histogram was the editor's grid snap, not the prop.
export const CUBES = [
  ['GemfanAirGatePopUpCube01', 1.45, 1.45, 'cube'],
  ['TrussGateCubeGeneric01', 6.00, 6.00, 'cube'],
];

export const POLES = [
  ['NexxbladesPylon300cm01', 3.00],
  ['IUDROPylon300cm01', 3.00],
  ['GemfanFlag360cm01', 3.60],
];

export const ALL = [...GATES, ...HOOPS, ...CUBES];
export const RACEABLE = ALL.filter((g) => g[3] !== 'startfinish');

// When to abandon the requested shape.
//
// Judging each gate against its own target was wrong in both directions: at x4
// a 1.45 m cube among 3.00 m gates read as broken, and at x2 the same cube
// among 1.52 m gates was fine but got substituted anyway. What decides whether
// a gate looks right is its size relative to the OTHER gates on the track, so
// substitution is judged against the track's median gate size.
export const RELATIVE_MIN = 0.65;

// CheckpointBoxFlexible01 has a BASE SIZE OF 1 METRE, so <scale> reads directly
// as metres. Measured from 10,139 scaled instances across the corpus: x and y
// cluster at 3-10 with a median near 5, while z clusters at 0.1-0.2. That is
// only coherent as "metres, thin plane".
//
// Sizing the trigger to the gate is the whole point: a fixed 2 m checkpoint in
// a 3 m gate leaves a ring you can fly through cleanly and still miss.
export const FLEX_CHECKPOINT = 'CheckpointBoxFlexible01';
export const FLEX_BASE_M = 1.0;
export const TRIGGER_DEPTH = 0.2;

// <scale> IS IGNORED ON PLAIN TrackBlueprintFlag. Across 1,200 workshop tracks,
// 0 of 724,714 gate props and 0 of 831,894 DrawingBoard primitives carry one --
// only flexible checkpoints (34%) and trigger boxes (100%) do. So every piece
// of geometry must be chosen at native size, never stretched.

export function triggerScale(gateW, gateH) {
  return [gateW / FLEX_BASE_M, gateH / FLEX_BASE_M, TRIGGER_DEPTH];
}

function nearest(pool, target) {
  return pool.reduce((best, g) =>
    Math.abs(g[1] - target) < Math.abs(best[1] - target) ? g : best);
}

/** Best prop of the requested family for this aperture. No substitution. */
export function pickGate(apertureM, kind) {
  const pool = RACEABLE.filter((g) => g[3] === kind).length
    ? RACEABLE.filter((g) => g[3] === kind)
    : RACEABLE.filter((g) => g[3] === 'square');
  const [item, w, h] = nearest(pool, apertureM);
  return [item, w, h];
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Choose props for a whole track at once, so shape can be judged in context.
 * `targets` is [[apertureM, kind], ...] in course order; returns a matching
 * list of [itemID, w, h, substituted].
 */
export function planGates(targets) {
  const picks = targets.map(([a, k]) => pickGate(a, k));
  if (!picks.length) return [];
  const med = median(picks.map((p) => p[1]));

  return picks.map(([item, w, h], i) => {
    if (w < med * RELATIVE_MIN) {
      const [alt, aw, ah] = nearest(RACEABLE, targets[i][0]);
      if (aw > w) return [alt, aw, ah, true];
    }
    return [item, w, h, false];
  });
}

/** Nearest native pole. Returns [itemID, nativeHeight]. */
export function pickPole(heightM) {
  return POLES.reduce((best, p) =>
    Math.abs(p[1] - heightM) < Math.abs(best[1] - heightM) ? p : best);
}

/** Returns [itemID, scale] for a trigger that fills the gate. */
export function pickCheckpoint(gateW, gateH) {
  return [FLEX_CHECKPOINT, triggerScale(gateW, gateH)];
}
