import * as THREE from 'three';
import { TransformControls } from '../vendor/TransformControls.js';
import { gateCenter } from './gates.js';
import { makeTextSprite } from './scene.js';

const POINT_COLOR = 0x00c2ff;
const POINT_SELECTED = 0xff6a00;
const LINE_COLOR = 0x00c2ff;

// Multi-point distance measuring. Click adds a point (snapping to a gate's
// opening center when a gate is clicked); each segment gets a floating
// length label. Esc finishes a chain; finished chains stay visible so they
// appear in screenshots.
//
// Existing points are editable: click a point (in select or measure mode)
// to grab it with a gizmo, drag to move it, Del to remove it. The whole
// overlay can be hidden/shown via setVisible.
export class MeasureTool {
  constructor(sceneMgr, editor, state) {
    this.sceneMgr = sceneMgr;
    this.editor = editor;
    this.state = state;
    this.chains = []; // [{ points: [Vector3], group, markers: [Mesh], labels: [Sprite], line }]
    this.current = null;
    this.selected = null; // { chain, index }
    this.onTotalChanged = () => {};
    this.onMarkerSelectionChanged = () => {};

    this.root = new THREE.Group();
    sceneMgr.scene.add(this.root);

    this.tc = new TransformControls(sceneMgr.camera, sceneMgr.canvas);
    this.tc.setSize(0.5);
    sceneMgr.scene.add(this.tc);
    this.tc.addEventListener('dragging-changed', (e) => {
      sceneMgr.controls.enabled = !e.value;
      if (!e.value && this.selected) {
        // Drag finished: clamp to the floor and refresh the label texts.
        const { chain, index } = this.selected;
        chain.points[index].y = Math.max(0, chain.points[index].y);
        this._rebuildChain(chain);
        this._refresh();
      }
    });
    this.tc.addEventListener('objectChange', () => this._onMarkerDragged());

    const canvas = sceneMgr.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      this._downAt = [e.clientX, e.clientY];
    });
    canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
  }

  get visible() {
    return this.root.visible;
  }

  setVisible(v) {
    this.root.visible = v;
    if (!v) this.deselectMarker();
  }

  // ---------- pointer handling ----------

  _onPointerUp(e) {
    if (e.button !== 0 || !this._downAt) return;
    const moved = Math.hypot(e.clientX - this._downAt[0], e.clientY - this._downAt[1]);
    this._downAt = null;
    if (moved > 5) return;
    if (this.tc.dragging) return;
    if (!['measure', 'select'].includes(this.state.mode)) return;

    // A click on an existing point grabs it for editing (in either mode).
    const marker = this.visible ? this.pickMarkerAt(e) : null;
    if (marker) {
      this.selectMarker(marker.chain, marker.index);
      return;
    }
    if (this.selected) {
      this.deselectMarker();
      return;
    }
    if (this.state.mode === 'measure') this._addPointFromEvent(e);
  }

  pickMarkerAt(e) {
    const markers = this.chains.flatMap((c) => c.markers);
    if (!markers.length) return null;
    const hit = this.sceneMgr.pickObjects(e, markers);
    return hit ? hit.object.userData : null;
  }

  _addPointFromEvent(e) {
    let point = null;
    const hit = this.sceneMgr.pickObjects(e, this.editor.gateObjects);
    if (hit) {
      // Snap to the gate's opening center — that's the distance you
      // replicate when building the track for real.
      let g = hit.object;
      while (g && !g.userData.isGate) g = g.parent;
      if (g) point = gateCenter(g);
    }
    if (!point) point = this.sceneMgr.pickFloor(e);
    if (!point) return;
    this.addPoint(point);
  }

  // ---------- chain building ----------

  addPoint(point) {
    if (!this.current) {
      this.current = { points: [], group: new THREE.Group(), markers: [], labels: [], line: null };
      this.root.add(this.current.group);
      this.chains.push(this.current);
    }
    this.current.points.push(point.clone());
    this._rebuildChain(this.current);
    this._refresh();
  }

  finishChain() {
    if (this.current && this.current.points.length < 2) {
      // A single orphan point isn't a measurement — drop it.
      this._removeChain(this.current);
    }
    this.current = null;
  }

  _removeChain(chain) {
    if (this.selected?.chain === chain) this.deselectMarker();
    this._disposeGroup(chain.group);
    this.root.remove(chain.group);
    this.chains.splice(this.chains.indexOf(chain), 1);
    if (this.current === chain) this.current = null;
  }

  _disposeGroup(group) {
    group.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
    group.clear();
  }

  _rebuildChain(chain) {
    const selectedIndex = this.selected?.chain === chain ? this.selected.index : -1;
    this._disposeGroup(chain.group);
    chain.markers = [];
    chain.labels = [];
    chain.line = null;

    chain.points.forEach((p, index) => {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 12, 12),
        new THREE.MeshBasicMaterial({ color: index === selectedIndex ? POINT_SELECTED : POINT_COLOR })
      );
      marker.position.copy(p);
      marker.userData = { chain, index };
      // Larger invisible hit area — the visible 3.5 cm sphere is a tiny
      // click target from typical camera distances.
      const hit = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 8, 8),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      hit.userData = marker.userData;
      marker.add(hit);
      chain.group.add(marker);
      chain.markers.push(marker);
    });

    if (chain.points.length >= 2) {
      chain.line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(chain.points),
        new THREE.LineBasicMaterial({ color: LINE_COLOR })
      );
      chain.group.add(chain.line);

      for (let i = 1; i < chain.points.length; i++) {
        const a = chain.points[i - 1];
        const b = chain.points[i];
        const label = makeTextSprite(`${a.distanceTo(b).toFixed(2)} m`, {
          height: 0.22,
          color: '#0af0ff',
          background: 'rgba(6,35,46,0.85)',
          alwaysOnTop: true,
        });
        label.position.copy(a).add(b).multiplyScalar(0.5);
        label.position.y += 0.12;
        chain.group.add(label);
        chain.labels.push(label);
      }
    }

    // The gizmo's target mesh was just replaced — re-attach it.
    if (selectedIndex >= 0) this.tc.attach(chain.markers[selectedIndex]);
  }

  // Live update while dragging a point: move the line and labels, but leave
  // label text for the rebuild on release (regenerating canvas textures
  // every frame is wasteful).
  _onMarkerDragged() {
    if (!this.selected) return;
    const { chain, index } = this.selected;
    chain.points[index].copy(chain.markers[index].position);
    chain.line?.geometry.setFromPoints(chain.points);
    for (let i = 1; i < chain.points.length; i++) {
      const label = chain.labels[i - 1];
      if (!label) continue;
      label.position.copy(chain.points[i - 1]).add(chain.points[i]).multiplyScalar(0.5);
      label.position.y += 0.12;
    }
  }

  // ---------- point selection & editing ----------

  selectMarker(chain, index) {
    this.deselectMarker();
    this.selected = { chain, index };
    chain.markers[index].material.color.setHex(POINT_SELECTED);
    this.tc.attach(chain.markers[index]);
    this.onMarkerSelectionChanged(this.selected);
  }

  deselectMarker() {
    if (!this.selected) return;
    const { chain, index } = this.selected;
    chain.markers[index]?.material.color.setHex(POINT_COLOR);
    this.tc.detach();
    this.selected = null;
    this.onMarkerSelectionChanged(null);
  }

  deleteSelectedPoint() {
    if (!this.selected) return;
    const { chain, index } = this.selected;
    this.deselectMarker();
    chain.points.splice(index, 1);
    if (chain.points.length < 2) {
      this._removeChain(chain);
    } else {
      this._rebuildChain(chain);
    }
    this._refresh();
  }

  // ---------- bulk ops & serialization ----------

  clearAll() {
    this.deselectMarker();
    for (const c of this.chains) {
      this._disposeGroup(c.group);
      this.root.remove(c.group);
    }
    this.chains = [];
    this.current = null;
    this._refresh();
  }

  total() {
    let t = 0;
    for (const c of this.chains) {
      for (let i = 1; i < c.points.length; i++) {
        t += c.points[i - 1].distanceTo(c.points[i]);
      }
    }
    return t;
  }

  _refresh() {
    this.onTotalChanged(this.total());
  }

  toJSON() {
    return this.chains
      .filter((c) => c.points.length >= 2)
      .map((c) => c.points.map((p) => [r3(p.x), r3(p.y), r3(p.z)]));
  }

  loadFrom(chains) {
    this.clearAll();
    for (const pts of chains || []) {
      for (const [x, y, z] of pts) this.addPoint(new THREE.Vector3(x, y, z));
      this.finishChain();
    }
  }
}

function r3(v) {
  return Math.round(v * 1000) / 1000;
}
