import * as THREE from 'three';
import { GLTFExporter } from '../vendor/GLTFExporter.js';

// Export the design as a glTF binary (.glb) for VR viewers, Blender, Unity
// and Unreal.
//
// Why GLB rather than OBJ: the chequered start line and every text label are
// CanvasTextures generated at runtime, so they exist only in memory — an OBJ
// would need them baked out to PNGs and shipped alongside an MTL, whereas GLB
// carries them inside the one file. glTF is also metres by definition, which
// matches the scene exactly, so this exports 1:1 with no scale factor (unlike
// the Liftoff export, which is forced to scale up to reach real prop sizes).
//
// Nothing here touches the live scene: everything exported is a clone.

export const DEFAULT_OPTIONS = {
  floor: true,
  grid: false, // lines survive glTF but most VR viewers quietly ignore them
  arrows: true,
  measurements: true,
  labels: true,
};

function safeName(name) {
  return (name || 'track').trim().replace(/[^\w-]+/g, '_') || 'track';
}

// Sprites are the one thing no glTF (or OBJ) exporter can carry: the format
// has no billboard primitive, so GLTFExporter drops them silently. Re-issue
// each one as a flat textured quad, aimed at the arena centre so the numbers
// read from inside the track, which is where you fly.
function spriteToQuad(sprite, faceTarget) {
  const scale = sprite.getWorldScale(new THREE.Vector3());
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(scale.x, scale.y),
    new THREE.MeshBasicMaterial({
      map: sprite.material.map,
      transparent: true,
      alphaTest: 0.05, // so viewers don't have to sort them correctly
      side: THREE.DoubleSide,
      toneMapped: false,
    })
  );
  quad.name = 'label';
  sprite.getWorldPosition(quad.position);

  const dx = faceTarget.x - quad.position.x;
  const dz = faceTarget.z - quad.position.z;
  // A plane's normal is +Z, so this yaw turns its face toward the target.
  if (dx * dx + dz * dz > 1e-8) quad.rotation.y = Math.atan2(dx, dz);
  return quad;
}

// Label quads must be built from the live objects, whose world matrices are
// current — a detached clone has never been through updateMatrixWorld.
function collectLabels(liveRoot, into, faceTarget) {
  liveRoot.traverse((o) => {
    if (o.isSprite && o.material?.map) into.add(spriteToQuad(o, faceTarget));
  });
}

// Invisible click targets: the fill across a gate's opening and the oversized
// hit spheres on measurement points. Exported they become phantom geometry.
function isPickHelper(o) {
  return o.name === 'pickFill' || (o.isMesh && o.material?.transparent && o.material.opacity === 0);
}

const MEASURE_COLOR = 0x00c2ff;
const MEASURE_POINT_RADIUS = 0.035;

// Measurement runs are rebuilt from their points rather than cloned.
// Object3D.copy deep-copies userData through JSON.stringify, and a
// measurement marker's userData points back at the chain that owns it — a
// cycle, so cloning one throws. Rebuilding also means the oversized invisible
// hit spheres never have to be pruned back out.
function buildMeasurements(measure) {
  const group = new THREE.Group();
  group.name = 'Measurements';
  const markerGeometry = new THREE.SphereGeometry(MEASURE_POINT_RADIUS, 12, 12);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: MEASURE_COLOR });
  const lineMaterial = new THREE.LineBasicMaterial({ color: MEASURE_COLOR });

  for (const chain of measure.chains) {
    if (chain.points.length < 2) continue; // same runs toJSON keeps
    const run = new THREE.Group();
    run.position.copy(chain.group.position); // chains sit just above the floor
    run.quaternion.copy(chain.group.quaternion);
    run.scale.copy(chain.group.scale);
    for (const point of chain.points) {
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.copy(point);
      run.add(marker);
    }
    run.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(chain.points),
      lineMaterial
    ));
    group.add(run);
  }
  return group;
}

function prune(clone, opts, directional) {
  const drop = [];
  clone.traverse((o) => {
    if (o.isSprite || isPickHelper(o)) {
      drop.push(o);
      return;
    }
    if (o.name === 'arrow') {
      // The viewport's ➤ toggle isn't the authority here, the export option
      // is — but a prop is not in the flight sequence and has no direction to
      // show, so it never carries an arrow whatever the option says.
      if (opts.arrows && directional) o.visible = true;
      else drop.push(o);
      return;
    }
    // userData lands in the glTF node's `extras`, which would repeat the whole
    // gate definition on every gate. The export sets its own below.
    o.userData = {};
    // Don't let a gate that happened to be selected export with its highlight.
    // Clone the material rather than reset it — the live scene shares it.
    if (o.isMesh && o.material?.emissive && o.material.emissive.getHex() !== 0x000000) {
      o.material = o.material.clone();
      o.material.emissive.setHex(0x000000);
    }
  });
  for (const o of drop) o.parent?.remove(o);
}

/**
 * Assemble a detached scene graph holding exactly what should be exported.
 *
 * @param {SceneManager} sceneMgr
 * @param {Editor} editor
 * @param {MeasureTool} measure
 * @param {object} options see DEFAULT_OPTIONS
 * @returns {THREE.Group}
 */
export function buildExportScene(sceneMgr, editor, measure, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  sceneMgr.scene.updateMatrixWorld(true); // label quads read world transforms

  const { w, d } = sceneMgr.arena;
  const centre = new THREE.Vector3(w / 2, 0, d / 2);
  const root = new THREE.Group();
  root.name = 'TrackDesigner';
  const labels = new THREE.Group();
  labels.name = 'Labels';

  const gates = new THREE.Group();
  gates.name = 'Gates';
  for (const entry of editor.gates) {
    const clone = entry.object.clone(true);
    clone.name = entry.prop
      ? `prop-${entry.typeId}`
      : `gate${entry.number ?? ''}-${entry.typeId}`;
    clone.visible = true;
    prune(clone, opts, !entry.prop);
    // Keep just enough for an importer to tell what a mesh actually is.
    clone.userData = { typeId: entry.typeId, prop: !!entry.prop };
    if (!entry.prop && entry.number) clone.userData.gateNumber = entry.number;
    gates.add(clone);
    if (opts.labels) collectLabels(entry.object, labels, centre);
  }
  root.add(gates);

  if (opts.floor) {
    const floor = sceneMgr.floor.clone();
    floor.name = 'Floor';
    floor.visible = true;
    root.add(floor);
  }

  if (opts.grid) {
    const grid = new THREE.Group();
    grid.name = 'Grid';
    for (const child of sceneMgr.arenaGroup.children) {
      if (child.name === 'gridMinor' || child.name === 'gridMajor') grid.add(child.clone());
      if (opts.labels && child.name === 'meterLabel') labels.add(spriteToQuad(child, centre));
    }
    root.add(grid);
  }

  if (opts.measurements && measure.chains.length) {
    // Built fresh, so the viewport's 👁 toggle never decides what lands in
    // the file; the labels still come off the live sprites.
    root.add(buildMeasurements(measure));
    if (opts.labels) collectLabels(measure.root, labels, centre);
  }

  if (labels.children.length) root.add(labels);
  return root;
}

/** Counts for the export dialog, so the size is not a surprise. */
export function exportStats(sceneMgr, editor, measure, options) {
  const root = buildExportScene(sceneMgr, editor, measure, options);
  let meshes = 0;
  let triangles = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const pos = o.geometry?.attributes?.position;
    if (pos) triangles += (o.geometry.index ? o.geometry.index.count : pos.count) / 3;
  });
  return { meshes, triangles: Math.round(triangles) };
}

/** Convert to a .glb Blob. */
export async function exportGLB(sceneMgr, editor, measure, options) {
  const root = buildExportScene(sceneMgr, editor, measure, options);
  const buffer = await new GLTFExporter().parseAsync(root, {
    binary: true,
    onlyVisible: true,
    embedImages: true, // banner artwork and canvas labels travel inside the file
    maxTextureSize: 2048,
  });
  return new Blob([buffer], { type: 'model/gltf-binary' });
}

/** Convert and hand it to the browser as a download. */
export async function downloadGLB(name, sceneMgr, editor, measure, options) {
  const blob = await exportGLB(sceneMgr, editor, measure, options);
  const filename = `${safeName(name)}.glb`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { filename, bytes: blob.size };
}
