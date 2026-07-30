import * as THREE from 'three';
import { TransformControls } from '../vendor/TransformControls.js';
import {
  buildGate,
  setGateHeight,
  setTableHeight,
  gateTop,
  applyArrowDirection,
  normalizeCubeDir,
  makeStartLine,
  propByDefault,
} from './gates.js';
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
    this.gates = []; // [{ typeId, def, object, rotY, dir }] — height lives in object.userData
    this.selected = null;
    this.placingDef = null;
    this.ghost = null;
    this.nextNumber = 1;
    this.showArrows = true;
    // When true (shared view-only link), all gate placement/selection/editing
    // is disabled. Measurements are handled by MeasureTool and stay enabled.
    this.readOnly = false;

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
    if (this.readOnly) return;
    this.cancelPlacement();
    this.deselect();
    this.placingDef = def;
    this.state.mode = 'place';
    this.ghost = buildGate(def, { ghost: true });
    this.ghost.visible = false;
    const ghostArrow = this.ghost.getObjectByName('arrow');
    if (ghostArrow) ghostArrow.visible = this.showArrows;
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
    if (this.readOnly) return; // shared view: no placing or selecting gates

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

  placeGate(
    def,
    x,
    z,
    { height = def.defaultHeight || 0, rotY = 0, dir = 'forward', prop = propByDefault(def), select = false } = {}
  ) {
    const object = buildGate(def);
    object.position.set(x, 0, z);
    object.rotation.y = rotY;
    if (object.getObjectByName('frame').userData.isTable) setTableHeight(object, height);
    else setGateHeight(object, height);
    this.group.add(object);
    const entry = { typeId: def.id, def, object, rotY, dir: 'forward', prop: !!prop };
    this.gates.push(entry);
    this._applyDir(entry, dir);
    this._applyArrowVisibility(entry);
    this._renumber();
    this.onGatesChanged();
    if (select) this.selectGate(object);
    return entry;
  }

  _arrowOf(entry) {
    return entry.object.getObjectByName('arrow');
  }

  _applyDir(entry, dir) {
    const multi = entry.object.getObjectByName('frame')?.userData.multiDirectional;
    entry.dir = multi ? normalizeCubeDir(dir) : dir === 'back' ? 'back' : 'forward';
    applyArrowDirection(entry.object, entry.dir);
  }

  _applyArrowVisibility(entry) {
    const arrow = this._arrowOf(entry);
    // A prop isn't part of the flight sequence, so it never shows an arrow.
    if (arrow) arrow.visible = this.showArrows && !entry.prop;
  }

  setArrowsVisible(v) {
    this.showArrows = v;
    for (const entry of this.gates) this._applyArrowVisibility(entry);
    const ghostArrow = this.ghost?.getObjectByName('arrow');
    if (ghostArrow) ghostArrow.visible = v;
  }

  deleteSelected() {
    if (this.readOnly || !this.selected) return;
    const entry = this.selected;
    this.deselect();
    this.group.remove(entry.object);
    this.gates.splice(this.gates.indexOf(entry), 1);
    this._renumber();
    this.onGatesChanged();
  }

  duplicateSelected() {
    if (this.readOnly || !this.selected) return;
    const s = this.selected;
    const entry = this.placeGate(s.def, s.object.position.x + 0.6, s.object.position.z, {
      height: s.object.userData.height,
      rotY: s.object.rotation.y,
      dir: s.dir,
    });
    this.selectGate(entry.object);
  }

  // Move a gate to flight position `newNumber` (1-based); the other gates
  // shift and everything renumbers. Props aren't in the sequence, so their
  // array positions are preserved as the gate moves around them.
  reorderGate(entry, newNumber) {
    if (this.readOnly || entry.prop || !Number.isFinite(newNumber)) return;
    const seq = this.gates.filter((g) => !g.prop);
    const target = THREE.MathUtils.clamp(Math.round(newNumber) - 1, 0, seq.length - 1);
    if (seq.indexOf(entry) === target) return;
    const full = this.gates.slice();
    full.splice(full.indexOf(entry), 1);
    const anchor = full.filter((g) => !g.prop)[target]; // insert before this gate
    const insertIdx = anchor ? full.indexOf(anchor) : full.length;
    full.splice(insertIdx, 0, entry);
    this.gates = full;
    this._renumber();
    this.onGatesChanged();
    if (this.selected === entry) this.onSelectionChanged(entry); // refresh the panel
  }

  clearAll() {
    this.deselect();
    this.cancelPlacement();
    for (const g of this.gates) this.group.remove(g.object);
    this.gates = [];
    this.onGatesChanged();
  }

  // Number the gates in flight order. Props (e.g. tables) are skipped — they
  // get no number and no label.
  _renumber() {
    let n = 0;
    this.gates.forEach((entry) => {
      const old = entry.object.getObjectByName('numberLabel');
      if (old) {
        entry.object.remove(old);
        old.material.map?.dispose();
        old.material.dispose();
      }
      if (entry.prop) {
        entry.number = null;
        return;
      }
      n++;
      entry.number = n;
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
    this._updateStartMarker();
  }

  // The chequered start/finish line lives under gate number 1 (the first
  // non-prop gate in the order).
  _updateStartMarker() {
    const first = this.gates.find((e) => !e.prop);
    this.gates.forEach((entry) => {
      const existing = entry.object.getObjectByName('startLine');
      if (entry === first && !existing) {
        entry.object.add(makeStartLine(entry.def));
      } else if (entry !== first && existing) {
        entry.object.remove(existing);
        existing.geometry.dispose();
        existing.material.map?.dispose();
        existing.material.dispose();
      }
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
    // Route through setTransformMode so the per-axis visibility flags from a
    // previous rotate-mode selection are reset, not just the mode.
    this.setTransformMode('translate');
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
    if (this.readOnly || !this.selected) return;
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
  applyProps(entry, { x, z, height, rotDeg, dir, prop }) {
    if (this.readOnly) return;
    const o = entry.object;
    const isTable = o.getObjectByName('frame').userData.isTable;
    if (Number.isFinite(x)) o.position.x = THREE.MathUtils.clamp(x, 0, this.sceneMgr.arena.w);
    if (Number.isFinite(z)) o.position.z = THREE.MathUtils.clamp(z, 0, this.sceneMgr.arena.d);
    if (Number.isFinite(height)) {
      if (isTable) {
        setTableHeight(o, height);
        this._applyDir(entry, entry.dir); // rebuild the fly-over arc at the new height
      } else {
        setGateHeight(o, Math.max(0, height));
      }
      const label = this._labelOf(entry);
      if (label) label.position.y = gateTop(o) + 0.22;
    }
    if (Number.isFinite(rotDeg)) o.rotation.y = THREE.MathUtils.degToRad(rotDeg);
    if (dir !== undefined) this._applyDir(entry, dir);
    if (prop !== undefined && !!prop !== entry.prop) {
      entry.prop = !!prop;
      this._renumber(); // add/remove this gate's number and shift the rest
      this._applyArrowVisibility(entry); // props show no arrow
      this.onSelectionChanged(entry); // Order row visibility depends on prop
    }
    this._syncEntry(entry);
    this.onGatesChanged();
  }

  // ---------- serialization ----------

  toJSON() {
    return this.gates.map((g) => {
      const isTable = g.object.getObjectByName('frame').userData.isTable;
      return {
        typeId: g.typeId,
        x: round3(g.object.position.x),
        z: round3(g.object.position.z),
        // For a table, "height" is its own height; for others, the mount offset.
        height: round3(isTable ? g.object.userData.tableHeight || 0 : g.object.userData.height || 0),
        rotY: round3(g.object.rotation.y),
        dir: g.dir || 'forward',
        prop: !!g.prop,
      };
    });
  }

  loadFrom(gateList, defsById) {
    this.clearAll();
    for (const g of gateList || []) {
      const def = defsById[g.typeId];
      if (!def) {
        console.warn(`Track references unknown gate type "${g.typeId}" — skipped`);
        continue;
      }
      // Older tracks saved a boolean `reversed` instead of `dir`, and had no
      // `prop` field (fall back to the type's default).
      this.placeGate(def, g.x, g.z, {
        height: g.height,
        rotY: g.rotY,
        dir: g.dir || (g.reversed ? 'back' : 'forward'),
        prop: g.prop !== undefined ? g.prop : propByDefault(def),
      });
    }
  }
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}
