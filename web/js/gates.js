import * as THREE from 'three';

// Gate geometry builders. Each builder receives a gate type definition
// (parsed from gates/*.json on the server) and returns a THREE.Group whose
// origin is the bottom-center of the frame. All dimensions are meters.
//
// To support a new `shape` value, add an entry to `shapeBuilders` (and
// optionally `thumbnailDrawers` for the palette icon).

const HEX_APOTHEM = Math.cos(Math.PI / 6); // apothem/circumradius ratio

function frameMaterial(def) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(def.color || '#ff6a00'),
    roughness: 0.6,
    metalness: 0.1,
  });
}

export const shapeBuilders = {
  square(def) {
    const g = new THREE.Group();
    const mat = frameMaterial(def);
    const inner = def.innerSize;
    const tube = def.tubeWidth;
    const depth = def.depth || tube;
    const outer = inner + 2 * tube;

    const horiz = new THREE.BoxGeometry(outer, tube, depth);
    const vert = new THREE.BoxGeometry(tube, inner, depth);
    const bottom = new THREE.Mesh(horiz, mat);
    bottom.position.y = tube / 2;
    const top = new THREE.Mesh(horiz, mat);
    top.position.y = inner + 1.5 * tube;
    const left = new THREE.Mesh(vert, mat);
    left.position.set(-(inner + tube) / 2, tube + inner / 2, 0);
    const right = new THREE.Mesh(vert, mat);
    right.position.set((inner + tube) / 2, tube + inner / 2, 0);
    g.add(bottom, top, left, right);
    g.userData.frameHeight = outer;
    return g;
  },

  hex(def) {
    const g = new THREE.Group();
    const inner = def.innerSize;
    const tube = def.tubeWidth;
    const depth = def.depth || tube;
    // innerSize is measured flat-to-flat (the usable opening).
    const rInner = inner / 2 / HEX_APOTHEM;
    const rOuter = (inner / 2 + tube) / HEX_APOTHEM;

    const hexPath = (r) => {
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i; // vertices at the sides → flat top/bottom
        pts.push(new THREE.Vector2(r * Math.cos(a), r * Math.sin(a)));
      }
      return pts;
    };
    const shape = new THREE.Shape(hexPath(rOuter));
    shape.holes.push(new THREE.Path(hexPath(rInner)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.translate(0, 0, -depth / 2);

    const mesh = new THREE.Mesh(geo, frameMaterial(def));
    const apothemOuter = inner / 2 + tube;
    mesh.position.y = apothemOuter; // rest the flat bottom edge on y=0
    g.add(mesh);
    g.userData.frameHeight = 2 * apothemOuter;
    return g;
  },

  circle(def) {
    const g = new THREE.Group();
    const inner = def.innerSize;
    const tube = def.tubeWidth;
    const ringRadius = inner / 2 + tube / 2;
    const geo = new THREE.TorusGeometry(ringRadius, tube / 2, 16, 48);
    const mesh = new THREE.Mesh(geo, frameMaterial(def));
    mesh.position.y = ringRadius + tube / 2; // bottom of the hoop on y=0
    g.add(mesh);
    g.userData.frameHeight = inner + 2 * tube;
    return g;
  },

  // A wireframe cube you can fly through along any axis. innerSize is the
  // opening (inner edge length), tubeWidth the frame member thickness.
  cube(def) {
    const g = new THREE.Group();
    const mat = frameMaterial(def);
    const inner = def.innerSize;
    const tube = def.tubeWidth;
    const outer = inner + 2 * tube;
    const off = (inner + tube) / 2;
    const yBot = tube / 2;
    const yTop = inner + 1.5 * tube;
    const yMid = tube + inner / 2;

    const beamX = new THREE.BoxGeometry(outer, tube, tube); // full-width, covers corners
    const beamZ = new THREE.BoxGeometry(tube, tube, inner);
    const beamY = new THREE.BoxGeometry(tube, inner, tube);
    const add = (geo, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
    };
    for (const z of [-off, off]) {
      add(beamX, 0, yBot, z);
      add(beamX, 0, yTop, z);
    }
    for (const x of [-off, off]) {
      add(beamZ, x, yBot, 0);
      add(beamZ, x, yTop, 0);
      for (const z of [-off, off]) add(beamY, x, yMid, z);
    }
    g.userData.frameHeight = outer;
    // A cube can be flown through on any of its three axes, so the editor
    // offers all six directions instead of just forward/back.
    g.userData.multiDirectional = true;
    return g;
  },

  // A vertical turn-marker pole. innerSize is the pole height and tubeWidth
  // its diameter — there is no opening to fly through.
  pole(def) {
    const g = new THREE.Group();
    const h = def.innerSize;
    const r = (def.tubeWidth || 0.03) / 2;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), frameMaterial(def));
    pole.position.y = h / 2;
    g.add(pole);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 4, r * 5, 0.02, 16),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(def.stand?.color || '#333333'), roughness: 0.8 })
    );
    base.position.y = 0.01;
    g.add(base);
    g.userData.frameHeight = h;
    // A tall thin pick strip instead of the default square fill.
    g.userData.pickSize = { w: Math.max(0.15, r * 8), h };
    // You fly around a pole, not through it — no direction arrow.
    g.userData.directional = false;
    return g;
  },
};

// Per-shape labels/fields for the "New gate type" form. Shapes without an
// entry use `default`. innerSize/tubeWidth mean different things for a pole,
// and its frame-depth / mount-height / leg fields don't apply.
export const shapeFieldMeta = {
  default: {
    inner: 'Opening (m)',
    tube: 'Frame width (m)',
    showDepth: true,
    showHeight: true,
    showLegs: true,
    defaults: { inner: 0.5, tube: 0.04 },
  },
  pole: {
    inner: 'Height (m)',
    tube: 'Diameter (m)',
    showDepth: false,
    showHeight: false,
    showLegs: false,
    defaults: { inner: 1.5, tube: 0.03 },
  },
  cube: {
    inner: 'Opening (m)',
    tube: 'Frame width (m)',
    showDepth: false, // a cube is as deep as it is wide
    showHeight: true,
    showLegs: true,
    defaults: { inner: 0.5, tube: 0.03 },
  },
};

// ---------- fly-through directions ----------
//
// Planar gates have a single arrow along ±Z ('forward' / 'back').
// Multidirectional shapes (cube) use an "in>out" face pair, e.g.
// "top>front" — enter through the top, exit through the front. When the
// faces are opposite it renders as one straight arrow; otherwise as two
// arrows meeting at the cube's center (entry in, exit out).

const FACE_NORMALS = {
  front: [0, 0, -1],
  back: [0, 0, 1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
};

export const CUBE_FACES = {
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
  top: 'Top',
  bottom: 'Bottom',
};

export const OPPOSITE_FACE = {
  front: 'back',
  back: 'front',
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
};

// Tracks saved by earlier versions used single keywords for cube directions.
const LEGACY_CUBE_DIRS = {
  forward: 'front>back',
  back: 'back>front',
  right: 'left>right',
  left: 'right>left',
  down: 'top>bottom',
  up: 'bottom>top',
};

export function normalizeCubeDir(dir) {
  if (dir?.includes('>')) return dir;
  return LEGACY_CUBE_DIRS[dir] || 'front>back';
}

// One arrow mesh from `from` to `to` (local coordinates of the arrow group).
function arrowSegment(from, to) {
  const dirV = to.clone().sub(from);
  const len = dirV.length();
  const coneLen = Math.min(0.14, len * 0.35);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9 });
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len - coneLen, 8), mat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = (len - coneLen) / 2;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.05, coneLen, 12), mat);
  cone.rotation.x = Math.PI / 2;
  cone.position.z = len - coneLen / 2;
  g.add(shaft, cone);
  g.traverse((o) => {
    if (o.isMesh) o.userData.noShadow = true;
  });
  g.position.copy(from);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dirV.normalize());
  return g;
}

// (Re)builds the arrow meshes inside the gate's 'arrow' container for the
// given direction value.
export function applyArrowDirection(gate, dir) {
  const frame = gate.getObjectByName('frame');
  const arrow = frame?.getObjectByName('arrow');
  if (!arrow) return;
  for (let i = arrow.children.length - 1; i >= 0; i--) {
    const c = arrow.children[i];
    arrow.remove(c);
    c.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
  }
  arrow.rotation.set(0, 0, 0);
  const def = gate.userData.def;

  if (frame.userData.multiDirectional) {
    const [inFace, outFace] = normalizeCubeDir(dir).split('>');
    const nIn = new THREE.Vector3(...(FACE_NORMALS[inFace] || FACE_NORMALS.front));
    const nOut = new THREE.Vector3(...(FACE_NORMALS[outFace] || FACE_NORMALS.back));
    const reach = frame.userData.frameHeight / 2 + 0.12;
    const entry = nIn.clone().multiplyScalar(reach);
    const exit = nOut.clone().multiplyScalar(reach);
    if (OPPOSITE_FACE[inFace] === outFace) {
      arrow.add(arrowSegment(entry, exit)); // straight through — one arrow
    } else {
      const center = new THREE.Vector3();
      arrow.add(arrowSegment(entry, center), arrowSegment(center, exit));
    }
  } else {
    const len = Math.max(0.4, def.innerSize * 0.9);
    const half = new THREE.Vector3(0, 0, len / 2);
    arrow.add(arrowSegment(half.clone().negate(), half));
    arrow.rotation.y = dir === 'back' ? Math.PI : 0;
  }
}

// 2D palette icons, one per shape family. Falls back to a filled dot.
export const thumbnailDrawers = {
  square(ctx, s, lw) {
    ctx.strokeRect(lw, lw, s - 2 * lw, s - 2 * lw);
  },
  hex(ctx, s, lw) {
    const r = s / 2 - lw;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      const x = s / 2 + r * Math.cos(a);
      const y = s / 2 + r * Math.sin(a);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  },
  circle(ctx, s, lw) {
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - lw, 0, Math.PI * 2);
    ctx.stroke();
  },
  pole(ctx, s, lw) {
    ctx.lineWidth = Math.max(3, Math.min(lw, 5));
    ctx.beginPath();
    ctx.moveTo(s / 2, 3);
    ctx.lineTo(s / 2, s - 4);
    ctx.moveTo(s / 2 - 7, s - 4);
    ctx.lineTo(s / 2 + 7, s - 4);
    ctx.stroke();
  },
  cube(ctx, s, lw) {
    ctx.lineWidth = Math.max(2, lw * 0.6);
    const o = Math.round(s * 0.22); // depth offset of the back face
    const m = ctx.lineWidth;
    const size = s - o - 2 * m;
    const fx = m;
    const fy = m + o;
    ctx.strokeRect(fx + o, m, size, size); // back face
    ctx.strokeRect(fx, fy, size, size); // front face
    ctx.beginPath();
    for (const [cx, cy] of [[fx, fy], [fx + size, fy], [fx, fy + size], [fx + size, fy + size]]) {
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + o, cy - o);
    }
    ctx.stroke();
  },
};

export function makeThumbnail(def, size = 34) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const lw = Math.max(3, (def.tubeWidth / def.innerSize) * size);
  ctx.lineWidth = lw;
  ctx.strokeStyle = def.color || '#ff6a00';
  ctx.fillStyle = def.color || '#ff6a00';
  const draw = thumbnailDrawers[def.shape];
  if (draw) {
    draw(ctx, size, lw);
  } else {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 4, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

// Builds the full placeable gate: a group whose origin sits on the floor.
// The frame is lifted to `height` via setGateHeight, which also (re)builds
// the stand legs connecting the frame to the floor.
export function buildGate(def, { ghost = false } = {}) {
  const builder = shapeBuilders[def.shape];
  if (!builder) throw new Error(`Unknown gate shape "${def.shape}" (id: ${def.id})`);

  const gate = new THREE.Group();
  const frame = builder(def);
  frame.name = 'frame';
  gate.add(frame);

  // Invisible fill across the opening so clicking the middle of a gate
  // selects it (and measure clicks snap to it) instead of passing through.
  // Builders can override the size (e.g. a pole uses a tall thin strip).
  const pickSize = frame.userData.pickSize || { w: def.innerSize, h: def.innerSize };
  const pick = new THREE.Mesh(
    new THREE.PlaneGeometry(pickSize.w, pickSize.h),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
  );
  pick.name = 'pickFill';
  pick.position.y = frame.userData.frameHeight / 2;
  frame.add(pick);

  // Flight-direction arrow container, filled by applyArrowDirection. Lives
  // inside the frame group so it follows the gate's height and rotation.
  if (frame.userData.directional !== false) {
    const arrow = new THREE.Group();
    arrow.name = 'arrow';
    arrow.position.y = frame.userData.frameHeight / 2;
    frame.add(arrow);
  }

  const legs = new THREE.Group();
  legs.name = 'legs';
  gate.add(legs);

  gate.userData.isGate = true;
  gate.userData.def = def;
  applyArrowDirection(gate, 'forward');

  gate.traverse((o) => {
    if (o.isMesh && o.name !== 'pickFill' && !o.userData.noShadow) {
      o.castShadow = !ghost;
      if (ghost) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.45;
        o.material.depthWrite = false;
      }
    }
  });

  setGateHeight(gate, def.defaultHeight || 0, ghost);
  return gate;
}

export function setGateHeight(gate, height, ghost = false) {
  height = Math.max(0, height);
  const def = gate.userData.def;
  const frame = gate.getObjectByName('frame');
  frame.position.y = height;
  gate.userData.height = height;

  const legs = gate.getObjectByName('legs');
  for (let i = legs.children.length - 1; i >= 0; i--) {
    const c = legs.children[i];
    legs.remove(c);
    c.geometry?.dispose();
    c.material?.dispose();
  }
  if (height > 0.01) {
    const standColor = new THREE.Color(def.stand?.color || '#333333');
    const mat = new THREE.MeshStandardMaterial({
      color: standColor,
      roughness: 0.8,
      transparent: ghost,
      opacity: ghost ? 0.45 : 1,
    });
    const spread = def.innerSize / 2 + def.tubeWidth / 2;
    for (const x of [-spread, spread]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, height, 8), mat);
      leg.position.set(x, height / 2, 0);
      leg.castShadow = !ghost;
      legs.add(leg);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.015, 0.16), mat);
      foot.position.set(x, 0.0075, 0);
      foot.castShadow = !ghost;
      legs.add(foot);
    }
  }
}

// World-space center of the gate opening — measurement points snap here.
export function gateCenter(gate) {
  const def = gate.userData.def;
  const frameH = gate.getObjectByName('frame').userData.frameHeight || def.innerSize;
  const local = new THREE.Vector3(0, (gate.userData.height || 0) + frameH / 2, 0);
  return gate.localToWorld(local);
}

// Height of the top of the gate above the floor (for placing labels).
export function gateTop(gate) {
  const def = gate.userData.def;
  const frameH = gate.getObjectByName('frame').userData.frameHeight || def.innerSize;
  return (gate.userData.height || 0) + frameH;
}
