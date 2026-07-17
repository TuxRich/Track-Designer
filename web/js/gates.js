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
};

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

  const legs = new THREE.Group();
  legs.name = 'legs';
  gate.add(legs);

  gate.userData.isGate = true;
  gate.userData.def = def;

  gate.traverse((o) => {
    if (o.isMesh && o.name !== 'pickFill') {
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
