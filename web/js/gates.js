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

  // A solid table: tabletop slab on four legs. innerSize is the tabletop
  // width (X), depth the tabletop depth (Z), defaultHeight the table height.
  // The body is (re)built by setTableHeight so the height can be edited; the
  // builder just sets up an empty container. You don't fly through a table —
  // it's non-directional and usually a prop (see propByDefault).
  table(def) {
    const g = new THREE.Group();
    const body = new THREE.Group();
    body.name = 'tableBody';
    g.add(body);
    g.userData.isTable = true;
    g.userData.frameHeight = def.defaultHeight || 0.7;
    // Used as a gate, a table gets the normal straight direction arrow (sat
    // under the tabletop by setTableHeight — you fly under it). Hidden while
    // it's a prop.
    g.userData.pickSize = { w: def.innerSize, h: def.defaultHeight || 0.7 };
    return g;
  },

  // A chair: a floor prop like the table (seat on legs, plus a backrest).
  // innerSize is the seat width, depth its depth, defaultHeight the seat
  // height. Body (re)built by setTableHeight; furniture, so non-directional.
  chair(def) {
    const g = new THREE.Group();
    const body = new THREE.Group();
    body.name = 'tableBody';
    g.add(body);
    g.userData.isTable = true; // floor prop: sits on the floor, height editable
    g.userData.frameHeight = def.defaultHeight || 0.45;
    g.userData.directional = false; // furniture — no fly-through arrow
    g.userData.pickSize = { w: def.innerSize, h: def.defaultHeight || 0.45 };
    return g;
  },

  // A wide solid banner/hoarding (sponsor or club board) you fly OVER, not
  // through. innerSize is the width, depth the panel height, tubeWidth the
  // border/panel thickness. Uses the standard mount-height mechanic so it can
  // stand on the floor or be raised on side posts. Marked flyOver so its
  // arrow arcs over the top edge instead of pointing through the panel.
  banner(def) {
    const g = new THREE.Group();
    const W = def.innerSize;
    const H = def.depth || 0.6;
    const thick = Math.max(0.02, def.tubeWidth || 0.03);

    const panelMat = frameMaterial(def);
    if (def.image) {
      // Sponsor/club artwork from the banners directory, stretched to fit.
      const tex = new THREE.TextureLoader().load(`/banners/${encodeURIComponent(def.image)}`);
      tex.colorSpace = THREE.SRGBColorSpace;
      panelMat.map = tex;
      panelMat.color.set(0xffffff); // show the image at full brightness
    }
    const panel = new THREE.Mesh(new THREE.BoxGeometry(W, H, thick), panelMat);
    panel.position.y = H / 2;
    g.add(panel);

    // Dark border bars so it reads as a framed sign.
    const borderMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
    const bw = thick;
    const bz = thick * 1.4;
    const bars = [
      [new THREE.BoxGeometry(W + bw, bw, bz), 0, H],
      [new THREE.BoxGeometry(W + bw, bw, bz), 0, 0],
      [new THREE.BoxGeometry(bw, H + bw, bz), -W / 2, H / 2],
      [new THREE.BoxGeometry(bw, H + bw, bz), W / 2, H / 2],
    ];
    for (const [geo, x, y] of bars) {
      const bar = new THREE.Mesh(geo, borderMat);
      bar.position.set(x, y, 0);
      g.add(bar);
    }

    g.userData.frameHeight = H;
    g.userData.flyOver = true; // you fly over the top, not through
    g.userData.pickSize = { w: W, h: H };
    return g;
  },
};

function ghostable(mat, ghost) {
  if (ghost) {
    mat.transparent = true;
    mat.opacity = 0.45;
    mat.depthWrite = false;
  }
  return mat;
}

// Fills a floor prop's body group (tabletop/seat, legs, etc.) sized to `def`
// at height `H`. Applied at build time and whenever the height changes.
// Dispatches on shape so tables and chairs share the same height mechanic.
function buildTableMeshes(body, def, H, ghost) {
  if (def.shape === 'chair') return buildChairMeshes(body, def, H, ghost);

  const W = def.innerSize;
  const D = def.depth || def.innerSize;
  const t = Math.max(0.02, def.tubeWidth || 0.05);
  const topMat = ghostable(frameMaterial(def), ghost);
  const legColor = new THREE.Color(def.stand?.color || '#5a3a1a');
  const legMat = ghostable(new THREE.MeshStandardMaterial({ color: legColor, roughness: 0.85 }), ghost);

  const top = new THREE.Mesh(new THREE.BoxGeometry(W, t, D), topMat);
  top.position.y = H - t / 2;
  top.castShadow = !ghost;
  top.receiveShadow = !ghost;
  body.add(top);

  const legH = Math.max(0.02, H - t);
  const inset = t / 2 + 0.03;
  for (const sx of [-(W / 2 - inset), W / 2 - inset]) {
    for (const sz of [-(D / 2 - inset), D / 2 - inset]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(t, legH, t), legMat);
      leg.position.set(sx, legH / 2, sz);
      leg.castShadow = !ghost;
      body.add(leg);
    }
  }
}

// A chair: seat slab on four legs, with two back posts and an upper back
// panel at the rear (-Z) edge. `H` is the seat height.
function buildChairMeshes(body, def, H, ghost) {
  const W = def.innerSize;
  const D = def.depth || def.innerSize;
  const t = Math.max(0.02, def.tubeWidth || 0.04);
  const seatMat = ghostable(frameMaterial(def), ghost);
  const frameColor = new THREE.Color(def.stand?.color || '#5a3a1a');
  const frameMat = ghostable(new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.85 }), ghost);
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = !ghost;
    body.add(m);
    return m;
  };

  add(new THREE.BoxGeometry(W, t, D), seatMat, 0, H - t / 2, 0).receiveShadow = !ghost;

  const legH = Math.max(0.02, H - t);
  const inset = t / 2 + 0.03;
  const xEdge = W / 2 - inset;
  const zEdge = D / 2 - inset;
  for (const sx of [-xEdge, xEdge]) {
    for (const sz of [-zEdge, zEdge]) add(new THREE.BoxGeometry(t, legH, t), frameMat, sx, legH / 2, sz);
  }

  // Backrest at the rear edge: two posts plus an upper panel.
  const backRise = Math.max(0.35, H);
  const zBack = -zEdge;
  for (const sx of [-xEdge, xEdge]) add(new THREE.BoxGeometry(t, backRise, t), frameMat, sx, H + backRise / 2, zBack);
  const panelH = backRise * 0.55;
  add(new THREE.BoxGeometry(W - 2 * inset, panelH, t * 0.8), seatMat, 0, H + backRise - panelH / 2 - 0.03, zBack);
}

// Sets a table's height, rebuilding its body. Unlike setGateHeight (which
// lifts a gate off the floor on stand legs), a table always sits on the
// floor and `height` is the table's own height.
export function setTableHeight(gate, height, ghost = false) {
  height = Math.max(0.05, height);
  const def = gate.userData.def;
  const frame = gate.getObjectByName('frame');
  const body = frame.getObjectByName('tableBody');
  for (let i = body.children.length - 1; i >= 0; i--) {
    const c = body.children[i];
    body.remove(c);
    c.geometry?.dispose();
    c.material?.dispose();
  }
  buildTableMeshes(body, def, height, ghost);
  frame.position.y = 0;
  frame.userData.frameHeight = height;
  gate.userData.height = 0;
  gate.userData.tableHeight = height;
  const pick = frame.getObjectByName('pickFill');
  if (pick) pick.position.y = height / 2;
  // Sit the straight direction arrow in the clear space under the tabletop —
  // you fly under the table, between the legs (segments rebuilt by the editor).
  const arrow = frame.getObjectByName('arrow');
  if (arrow) arrow.position.y = Math.max(0.1, height * 0.4);
}

// Whether a gate type is a prop (not part of the flight sequence) by default.
export function propByDefault(def) {
  return !!shapeFieldMeta[def.shape]?.propByDefault;
}

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
  table: {
    inner: 'Width (m)',
    tube: 'Leg / top thickness (m)',
    depthLabel: 'Depth (m)',
    heightLabel: 'Table height (m)',
    legsLabel: 'Leg colour',
    showDepth: true,
    showHeight: true,
    showLegs: true,
    // Tables are usually props to stand gates on, so default to "not a gate".
    propByDefault: true,
    defaults: { inner: 1.2, tube: 0.05, depth: 0.6, height: 0.7 },
  },
  chair: {
    inner: 'Seat width (m)',
    tube: 'Frame thickness (m)',
    depthLabel: 'Seat depth (m)',
    heightLabel: 'Seat height (m)',
    legsLabel: 'Frame colour',
    showDepth: true,
    showHeight: true,
    showLegs: true,
    propByDefault: true, // furniture prop, not a gate
    defaults: { inner: 0.45, tube: 0.04, depth: 0.45, height: 0.45 },
  },
  banner: {
    inner: 'Width (m)',
    tube: 'Border thickness (m)',
    depthLabel: 'Panel height (m)',
    heightLabel: 'Bottom height (m)',
    legsLabel: 'Post colour',
    showDepth: true,
    showHeight: true,
    showLegs: true,
    showImage: true, // banner artwork from the banners folder
    defaults: { inner: 2.0, tube: 0.03, depth: 0.6, height: 0 },
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

// An arc that rises from the front, over the top edge, and down the back —
// the "fly over this" cue for banners. `reverse` flips the travel direction.
function flyOverArrow(frameHeight, reverse) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9 });
  const half = frameHeight / 2;
  const reach = Math.max(0.35, half + 0.15);
  const peak = half + 0.22; // clear the top edge
  const sign = reverse ? -1 : 1;
  const start = new THREE.Vector3(0, 0, -reach * sign);
  const end = new THREE.Vector3(0, 0, reach * sign);
  const curve = new THREE.CatmullRomCurve3([start, new THREE.Vector3(0, peak, 0), end]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.012, 8, false), mat));
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 12), mat);
  cone.position.copy(end);
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(1).normalize());
  g.add(cone);
  g.traverse((o) => {
    if (o.isMesh) o.userData.noShadow = true;
  });
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
  } else if (frame.userData.flyOver) {
    arrow.add(flyOverArrow(frame.userData.frameHeight, dir === 'back'));
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
  table(ctx, s, lw) {
    ctx.lineWidth = Math.max(2, lw * 0.6);
    const m = ctx.lineWidth + 1;
    const topY = s * 0.32;
    ctx.beginPath();
    ctx.moveTo(m, topY); // tabletop
    ctx.lineTo(s - m, topY);
    for (const x of [m + 3, s - m - 3]) {
      ctx.moveTo(x, topY); // legs
      ctx.lineTo(x, s - m);
    }
    ctx.stroke();
  },
  banner(ctx, s, lw) {
    ctx.lineWidth = Math.max(2, lw * 0.6);
    const m = ctx.lineWidth + 1;
    const h = (s - 2 * m) * 0.5;
    const y = (s - h) / 2;
    ctx.fillRect(m, y, s - 2 * m, h); // solid (blocked) panel
    ctx.strokeStyle = '#1a1a1a';
    ctx.strokeRect(m, y, s - 2 * m, h);
  },
  chair(ctx, s, lw) {
    ctx.lineWidth = Math.max(2, lw * 0.6);
    const m = ctx.lineWidth + 2;
    const seatY = s * 0.56;
    const backX = s - m - 3;
    ctx.beginPath();
    ctx.moveTo(m, seatY); // seat
    ctx.lineTo(backX, seatY);
    ctx.moveTo(backX, seatY); // backrest
    ctx.lineTo(backX, m);
    ctx.moveTo(m + 2, seatY); // front leg
    ctx.lineTo(m + 2, s - m);
    ctx.moveTo(backX, seatY); // back leg
    ctx.lineTo(backX, s - m);
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

// Chequered start/finish line drawn on the floor under gate number 1. The
// editor adds/removes it as the track order changes.
export function makeStartLine(def) {
  const cols = 14;
  const rows = 3;
  const cell = 16;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = (r + c) % 2 ? '#e8e8e8' : '#111111';
      ctx.fillRect(c * cell, r * cell, cell, cell);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;

  const width = def.shape === 'pole' ? 0.6 : def.innerSize + 2 * (def.tubeWidth || 0) + 0.4;
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(width, 0.24),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
  );
  line.name = 'startLine';
  line.rotation.x = -Math.PI / 2;
  line.position.y = 0.006; // just above the floor, below the grid lines' z-fight zone
  return line;
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

  if (frame.userData.isTable) setTableHeight(gate, def.defaultHeight || 0.7, ghost);
  else setGateHeight(gate, def.defaultHeight || 0, ghost);
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
