// Export the placed track as a USDZ model — the format Quick Look on iOS and
// macOS opens natively, so a track can be walked around in AR on a phone.
//
// Only the physical props are exported. Designer annotations that have no
// meaning as geometry are left out:
//   • numberLabel — a camera-facing sprite, which USD has no equivalent for
//   • pickFill    — the invisible click target
// Direction arrows ARE included: they are real meshes and are the whole point
// of handing someone a model of the track.

import * as THREE from 'three';
import { USDZExporter } from '../../vendor/USDZExporter.js';

const SKIP = new Set(['numberLabel', 'pickFill']);

/**
 * Build a clean scene holding just the exportable geometry.
 *
 * The gates are cloned rather than exported in place so that hiding helper
 * children, and the Y-up/Z-up conversion below, cannot disturb the live scene.
 *
 * @param {Array} gates editor.gates entries
 * @param {boolean} includeArrows
 * @returns {{scene: THREE.Group, meshes: number}}
 */
function buildExportScene(gates, includeArrows) {
  // No axis conversion here: USDZExporter writes upAxis = "Y", matching
  // three.js, so the track stands up correctly as-is.
  const scene = new THREE.Group();
  scene.name = 'Track';

  for (const entry of gates) {
    const clone = entry.object.clone(true);
    // Drop the helpers. Collect first: removing during a live traverse
    // would skip siblings.
    const doomed = [];
    clone.traverse((o) => {
      if (SKIP.has(o.name) || o.isSprite) doomed.push(o);
      else if (o.name === 'arrow' && !includeArrows) doomed.push(o);
    });
    for (const o of doomed) o.parent?.remove(o);
    scene.add(clone);
  }

  // The exporter reads matrixWorld and never refreshes it itself; the clones
  // are in a group that has never been rendered, so update it here.
  scene.updateMatrixWorld(true);

  let meshes = 0;
  scene.traverse((o) => {
    if (o.isMesh) meshes++;
  });
  return { scene, meshes };
}

/** Same sanitising the screenshot and Liftoff exports use. */
function safeName(name) {
  return (name || 'track').trim().replace(/[^\w-]+/g, '_') || 'track';
}

/**
 * Convert the placed gates to USDZ.
 *
 * @param {Array} gates editor.gates entries
 * @param {object} opts {name, includeArrows}
 * @returns {Promise<{blob: Blob, filename: string, meshes: number}>}
 */
export async function exportUSDZ(gates, { name, includeArrows = true } = {}) {
  const { scene, meshes } = buildExportScene(gates, includeArrows);
  if (!meshes) throw new Error('nothing to export');

  const exporter = new USDZExporter();
  const arrayBuffer = await exporter.parseAsync(scene);

  return {
    blob: new Blob([arrayBuffer], { type: 'model/vnd.usdz+zip' }),
    filename: `${safeName(name)}.usdz`,
    meshes,
  };
}
