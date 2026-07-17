import * as THREE from 'three';
import { TransformControls } from '../vendor/TransformControls.js';
import { buildGate, setGateHeight, gateTop } from './gates.js';
import { makeTextSprite } from './scene.js';

const SNAP_MOVE = 0.1; // meters
const SNAP_ROT = THREE.MathUtils.degToRad(15);
const CLICK_SLOP_PX = 5;

// Owns all placed gates: placement ghost, selection, transform gizmo,
// numbering labels, and (de)serialization of the gate list.
export class Editor {
  constructor(sceneMgr, state) {
    this.sceneMgr = sceneMgr;
    this.state = state; // shared { mode } object
    this.gates = []; // [{ typeId, def, object, rotY }] — height lives in object.userData
    this.selected = null;
    this.placingDef = null;
    this.ghost = null;
    this.nextNumber = 1;

    // Hooks assigned by the UI layer.
    this.onSelectionChanged = () => {};
    this.onGatesChanged = () => {};
    this.onPlacementEnded = () => {};
    // When set, a truthy result means another tool (measure points) claims
    // this click — skip gate picking so overlapping targets don't both select.
    this.prePick = null;

    this.group = new THREE.Group();
    sceneMgr.scene.add(this.group);

    this.tc = new TransformControls(sceneMgr.camera, sceneMgr.canvas);
    this.tc.setSize(0.8);
    sceneMgr.scene.add(this.tc);
    this.setSnap(true);

    this.tc.addEventListener('dragging-changed', (e) => {
      sceneMgr.controls.enabled = !e.value;
      if (!e.value && this.selected) this._settleAfterDrag(this.selected);
    });
    this.tc.addEventListener('objectChange', () => {
      if (this.selected) this._syncEntry(this.selected);
      this.onGatesChanged();
    });

    const canvas = sceneMgr.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      this._downAt = [e.clientX, e.clientY];
    });
    canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
  }

  get gateObjects() {
    return this.gates.map((g) => g.object);
  }

  setSnap(on) {
    this.tc.setTranslationSnap(on ? SNAP_MOVE : null);
    this.tc.setRotationSnap(on ? SNAP_ROT : null);
  }

  // ---------- placement ----------

  startPlacement(def) {
    this.cancelPlacement();
    this.deselect();
    this.placingDef = def;
    this.state.mode = 'place';
    this.ghost = buildGate(def, { ghost: true });
    this.ghost.visible = false;
    this.group.add(this.ghost);
  }

  cancelPlacement() {
    if (this.ghost) {
      this.group.remove(this.ghost);
      this.ghost = null;
    }
    this.placingDef = null;
    if (this.state.mode === 'place') this.state.mode = 'select';
    this.onPlacementEnded();
  }

  _onPointerMove(e) {
    if (this.state.mode !== 'place' || !this.ghost) return;
    const p = this.sceneMgr.pickFloor(e);
    if (!p) {
      this.ghost.visible = false;
      return;
    }
    this.ghost.visible = true;
    this.ghost.position.set(this._snapVal(p.x), 0, this._snapVal(p.z));
  }

  _snapVal(v) {
    return this.tc.translationSnap ? Math.round(v / SNAP_MOVE) * SNAP_MOVE : v;
  }

  _onPointerUp(e) {
    if (e.button !== 0 || !this._downAt) return;
    const moved = Math.hypot(e.clientX - this._downAt[0], e.clientY - this._downAt[1]);
    this._downAt = null;
    if (moved > CLICK_SLOP_PX) return; // was an orbit/pan drag
    if (this.tc.dragging) return;

    if (this.state.mode === 'place' && this.ghost && this.ghost.visible) {
      this.placeGate(this.placingDef, this.ghost.position.x, this.ghost.position.z);
      return; // stay in placement mode for rapid multi-placement
    }

    if (this.state.mode === 'select') {
      if (this.prePick?.(e)) {
        this.deselect();
        return;
      }
      const hit = this.sceneMgr.pickObjects(e, this.gateObjects);
      if (hit) {
        this.selectGate(this._gateGroupOf(hit.object));
      } else {
        this.deselect();
      }
    }
  }

  _gateGroupOf(obj) {
    let o = obj;
    while (o && !o.userData.isGate) o = o.parent;
    return o;
  }

  // ---------- gate lifecycle ----------

  placeGate(def, x, z, { height = def.defaultHeight || 0, rotY = 0, select = false } = {}) {
    const object = buildGate(def);
    object.position.set(x, 0, z);
    object.rotation.y = rotY;
    setGateHeight(object, height);
    this.group.add(object);
    const entry = { typeId: def.id, def, object, rotY };
    this.gates.push(entry);
    this._renumber();
    this.onGatesChanged();
    if (select) this.selectGate(object);
    return entry;
  }

  deleteSelected() {
    if (!this.selected) return;
    const entry = this.selected;
    this.deselect();
    this.group.remove(entry.object);
    this.gates.splice(this.gates.indexOf(entry), 1);
    this._renumber();
    this.onGatesChanged();
  }

  duplicateSelected() {
    if (!this.selected) return;
    const s = this.selected;
    const entry = this.placeGate(s.def, s.object.position.x + 0.6, s.object.position.z, {
      height: s.object.userData.height,
      rotY: s.object.rotation.y,
    });
    this.selectGate(entry.object);
  }

  clearAll() {
    this.deselect();
    this.cancelPlacement();
    for (const g of this.gates) this.group.remove(g.object);
    this.gates = [];
    this.onGatesChanged();
  }

  _renumber() {
    this.gates.forEach((entry, i) => {
      const n = i + 1;
      if (entry.number === n && entry.object.getObjectByName('numberLabel')) return;
      entry.number = n;
      const old = entry.object.getObjectByName('numberLabel');
      if (old) {
        entry.object.remove(old);
        old.material.map.dispose();
        old.material.dispose();
      }
      const label = makeTextSprite(String(n), {
        height: 0.22,
        color: '#ffffff',
        background: 'rgba(20,22,27,0.8)',
        alwaysOnTop: true,
      });
      label.name = 'numberLabel';
      label.position.y = gateTop(entry.object) + 0.22;
      entry.object.add(label);
    });
  }

  _labelOf(entry) {
    return entry.object.getObjectByName('numberLabel');
  }

  // ---------- selection & transform ----------

  selectGate(object) {
    if (!object) return;
    if (this.selected?.object === object) return;
    this.deselect();
    const entry = this.gates.find((g) => g.object === object);
    if (!entry) return;
    this.selected = entry;
    this._setEmissive(object, 0x553311);
    this.tc.attach(object);
    this.tc.setMode('translate');
    this.onSelectionChanged(entry);
  }

  deselect() {
    if (!this.selected) return;
    this._setEmissive(this.selected.object, 0x000000);
    this.tc.detach();
    this.selected = null;
    this.onSelectionChanged(null);
  }

  setTransformMode(mode) {
    if (!this.selected) return;
    this.tc.setMode(mode);
    if (mode === 'rotate') {
      this.tc.showX = false;
      this.tc.showZ = false;
      this.tc.showY = true;
    } else {
      this.tc.showX = true;
      this.tc.showZ = true;
      this.tc.showY = true;
    }
  }

  _setEmissive(object, hex) {
    object.traverse((o) => {
      if (o.isMesh && o.material?.emissive) o.material.emissive.setHex(hex);
    });
  }

  // While dragging, TransformControls may move the group off the floor
  // (y != 0). On release, fold that offset into the gate's stand height and
  // clamp the gate inside the arena.
  _settleAfterDrag(entry) {
    const o = entry.object;
    if (Math.abs(o.position.y) > 1e-4) {
      const h = Math.max(0, (o.userData.height || 0) + o.position.y);
      o.position.y = 0;
      setGateHeight(o, this._snapHeight(h));
      const label = this._labelOf(entry);
      if (label) label.position.y = gateTop(o) + 0.22;
    }
    o.position.x = THREE.MathUtils.clamp(o.position.x, 0, this.sceneMgr.arena.w);
    o.position.z = THREE.MathUtils.clamp(o.position.z, 0, this.sceneMgr.arena.d);
    this._syncEntry(entry);
    this.onGatesChanged();
    this.onSelectionChanged(entry); // refresh the properties panel
  }

  _snapHeight(h) {
    return this.tc.translationSnap ? Math.round(h / 0.05) * 0.05 : h;
  }

  _syncEntry(entry) {
    entry.rotY = entry.object.rotation.y;
  }

  // Numeric edits from the properties panel.
  applyProps(entry, { x, z, height, rotDeg }) {
    const o = entry.object;
    if (Number.isFinite(x)) o.position.x = THREE.MathUtils.clamp(x, 0, this.sceneMgr.arena.w);
    if (Number.isFinite(z)) o.position.z = THREE.MathUtils.clamp(z, 0, this.sceneMgr.arena.d);
    if (Number.isFinite(height)) {
      setGateHeight(o, Math.max(0, height));
      const label = this._labelOf(entry);
      if (label) label.position.y = gateTop(o) + 0.22;
    }
    if (Number.isFinite(rotDeg)) o.rotation.y = THREE.MathUtils.degToRad(rotDeg);
    this._syncEntry(entry);
    this.onGatesChanged();
  }

  // ---------- serialization ----------

  toJSON() {
    return this.gates.map((g) => ({
      typeId: g.typeId,
      x: round3(g.object.position.x),
      z: round3(g.object.position.z),
      height: round3(g.object.userData.height || 0),
      rotY: round3(g.object.rotation.y),
    }));
  }

  loadFrom(gateList, defsById) {
    this.clearAll();
    for (const g of gateList || []) {
      const def = defsById[g.typeId];
      if (!def) {
        console.warn(`Track references unknown gate type "${g.typeId}" — skipped`);
        continue;
      }
      this.placeGate(def, g.x, g.z, { height: g.height, rotY: g.rotY });
    }
  }
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}
