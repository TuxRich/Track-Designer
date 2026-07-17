import * as THREE from 'three';
import { makeThumbnail, shapeBuilders, shapeFieldMeta, CUBE_FACES, OPPOSITE_FACE, normalizeCubeDir } from './gates.js';

const $ = (id) => document.getElementById(id);

// DOM layer: gate palette, properties panel, dialogs, status bar.
export class UI {
  constructor(editor, measure, sceneMgr, state) {
    this.editor = editor;
    this.measure = measure;
    this.sceneMgr = sceneMgr;
    this.state = state;

    this._wireProps();
    this._wireDialogs();

    editor.onSelectionChanged = (entry) => this._showProps(entry);
    editor.onPlacementEnded = () => this._setActivePaletteItem(null);
    measure.onTotalChanged = (t) => {
      $('measure-total').textContent = t > 0 ? `Σ ${t.toFixed(2)} m` : '';
    };
    measure.onMarkerSelectionChanged = (sel) => {
      if (sel) this.setStatus('Measurement point — drag to move, Del to remove, Esc to deselect');
      else if (this.state.mode !== 'measure') this.setStatus();
    };
    $('btn-show-measure').addEventListener('click', () => {
      this.setMeasureVisible(!this.measure.visible);
    });
    $('btn-show-arrows').addEventListener('click', () => {
      this.editor.setArrowsVisible(!this.editor.showArrows);
      $('btn-show-arrows').classList.toggle('active', this.editor.showArrows);
    });
  }

  setMeasureVisible(v) {
    this.measure.setVisible(v);
    $('btn-show-measure').classList.toggle('active', v);
    // Measuring with an invisible overlay makes no sense — leave the mode.
    if (!v && this.state.mode === 'measure') this.setMeasureActive(false);
  }

  buildPalette(defs) {
    const palette = $('palette');
    palette.innerHTML = '';
    for (const def of defs) {
      const item = document.createElement('div');
      item.className = 'palette-item';
      item.title = `${def.name} — click, then click the floor to place`;
      item.appendChild(makeThumbnail(def));
      const name = document.createElement('span');
      name.className = 'palette-name';
      name.textContent = def.name;
      item.appendChild(name);
      item.addEventListener('click', () => {
        if (this.state.mode === 'place' && this.editor.placingDef?.id === def.id) {
          this.editor.cancelPlacement();
          this._setActivePaletteItem(null);
        } else {
          this.setMeasureActive(false);
          this.editor.startPlacement(def);
          this._setActivePaletteItem(item);
          this.setStatus(`Placing ${def.name} — click the floor to place, Esc to stop`);
        }
      });
      palette.appendChild(item);
    }
  }

  _setActivePaletteItem(item) {
    document.querySelectorAll('.palette-item.active').forEach((el) => el.classList.remove('active'));
    if (item) item.classList.add('active');
    else this.setStatus();
  }

  setMeasureActive(on) {
    if (on) {
      this.editor.cancelPlacement();
      this.editor.deselect();
      if (!this.measure.visible) this.setMeasureVisible(true);
      this.state.mode = 'measure';
      $('btn-measure').classList.add('active');
      this.setStatus('Measuring — click points (gates snap to their centre), Esc to finish a run');
    } else {
      this.measure.finishChain();
      if (this.state.mode === 'measure') this.state.mode = 'select';
      $('btn-measure').classList.remove('active');
      this.setStatus();
    }
  }

  setStatus(text) {
    $('status-mode').textContent =
      text || 'Orbit — drag to rotate, right-drag to pan, scroll to zoom';
  }

  // ---------- properties panel ----------

  _wireProps() {
    const apply = () => {
      const entry = this.editor.selected;
      if (!entry || this._fillingProps) return;
      this.editor.applyProps(entry, {
        x: parseFloat($('prop-x').value),
        z: parseFloat($('prop-z').value),
        height: parseFloat($('prop-h').value),
        rotDeg: parseFloat($('prop-rot').value),
      });
    };
    for (const id of ['prop-x', 'prop-z', 'prop-h', 'prop-rot']) {
      $(id).addEventListener('change', apply);
    }
    $('prop-del').addEventListener('click', () => this.editor.deleteSelected());
    $('prop-dup').addEventListener('click', () => this.editor.duplicateSelected());
    $('prop-reverse').addEventListener('click', () => {
      const entry = this.editor.selected;
      if (entry) this.editor.applyProps(entry, { dir: entry.dir === 'back' ? 'forward' : 'back' });
    });
    for (const sel of [$('prop-dir-in'), $('prop-dir-out')]) {
      for (const [value, label] of Object.entries(CUBE_FACES)) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        sel.appendChild(opt);
      }
    }
    const updateCubeDir = (changed) => {
      const entry = this.editor.selected;
      if (!entry || this._fillingProps) return;
      const inSel = $('prop-dir-in');
      const outSel = $('prop-dir-out');
      // Entering and exiting the same face isn't a route — flip the other one.
      if (inSel.value === outSel.value) {
        if (changed === 'in') outSel.value = OPPOSITE_FACE[inSel.value];
        else inSel.value = OPPOSITE_FACE[outSel.value];
      }
      this.editor.applyProps(entry, { dir: `${inSel.value}>${outSel.value}` });
    };
    $('prop-dir-in').addEventListener('change', () => updateCubeDir('in'));
    $('prop-dir-out').addEventListener('change', () => updateCubeDir('out'));
  }

  _showProps(entry) {
    const panel = $('props');
    if (!entry) {
      panel.classList.add('hidden');
      return;
    }
    this._fillingProps = true;
    panel.classList.remove('hidden');
    $('prop-number').textContent = entry.number;
    $('prop-type').textContent = entry.def.name;
    $('prop-x').value = entry.object.position.x.toFixed(2);
    $('prop-z').value = entry.object.position.z.toFixed(2);
    $('prop-h').value = (entry.object.userData.height || 0).toFixed(2);
    $('prop-rot').value = Math.round(THREE.MathUtils.radToDeg(entry.object.rotation.y));
    // Poles have no fly-through direction. Planar gates get ⇄ Reverse;
    // multidirectional shapes (cube) get the full six-way dropdown.
    const hasArrow = !!entry.object.getObjectByName('arrow');
    const multi = !!entry.object.getObjectByName('frame')?.userData.multiDirectional;
    $('prop-reverse-label').classList.toggle('hidden', !hasArrow || multi);
    $('prop-reverse').classList.toggle('hidden', !hasArrow || multi);
    for (const id of ['prop-dir-in-label', 'prop-dir-in', 'prop-dir-out-label', 'prop-dir-out']) {
      $(id).classList.toggle('hidden', !hasArrow || !multi);
    }
    if (multi) {
      const [inFace, outFace] = normalizeCubeDir(entry.dir).split('>');
      $('prop-dir-in').value = inFace;
      $('prop-dir-out').value = outFace;
    }
    this._fillingProps = false;
  }

  // ---------- dialogs ----------

  _wireDialogs() {
    this.overlay = $('modal-overlay');
    $('arena-cancel').addEventListener('click', () => this.closeDialogs());
    $('gate-cancel').addEventListener('click', () => this.closeDialogs());
    $('load-cancel').addEventListener('click', () => this.closeDialogs());
    $('help-close').addEventListener('click', () => this.closeDialogs());
    $('btn-help').addEventListener('click', () => this.openDialog('dlg-help'));
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.closeDialogs();
    });
  }

  openDialog(id) {
    this.overlay.classList.remove('hidden');
    for (const dlg of this.overlay.querySelectorAll('.dialog')) {
      dlg.classList.toggle('hidden', dlg.id !== id);
    }
  }

  closeDialogs() {
    this.overlay.classList.add('hidden');
  }

  get dialogOpen() {
    return !this.overlay.classList.contains('hidden');
  }

  openArenaDialog(onApply) {
    const { w, d, h } = this.sceneMgr.arena;
    $('arena-w').value = w;
    $('arena-d').value = d;
    $('arena-h').value = h;
    this.openDialog('dlg-arena');
    $('arena-apply').onclick = () => {
      const nw = parseFloat($('arena-w').value);
      const nd = parseFloat($('arena-d').value);
      const nh = parseFloat($('arena-h').value);
      if (nw > 0 && nd > 0 && nh > 0) {
        onApply(nw, nd, nh);
        this.closeDialogs();
      }
    };
  }

  openGateDialog(onCreate) {
    const fields = {
      name: $('gate-name'),
      shape: $('gate-shape'),
      inner: $('gate-inner'),
      tube: $('gate-tube'),
      depth: $('gate-depth'),
      color: $('gate-color'),
      height: $('gate-height'),
      standColor: $('gate-stand-color'),
    };

    // Shape options come from the geometry builder registry, so a new shape
    // family added in gates.js shows up here automatically.
    fields.shape.innerHTML = '';
    for (const s of Object.keys(shapeBuilders)) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      fields.shape.appendChild(opt);
    }

    fields.name.value = '';
    fields.shape.value = 'square';
    fields.inner.value = '0.5';
    fields.tube.value = '0.04';
    fields.depth.value = '0.03';
    fields.color.value = '#ff6a00';
    fields.height.value = '0';
    fields.standColor.value = '#333333';
    $('gate-error').textContent = '';

    const slug = () =>
      fields.name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
      'gate';

    const buildDef = () => {
      const meta = shapeFieldMeta[fields.shape.value] || shapeFieldMeta.default;
      const tube = parseFloat(fields.tube.value);
      return {
        id: slug(),
        name: fields.name.value.trim(),
        shape: fields.shape.value,
        innerSize: parseFloat(fields.inner.value),
        tubeWidth: tube,
        depth: meta.showDepth ? parseFloat(fields.depth.value) : tube,
        color: fields.color.value,
        defaultHeight: meta.showHeight ? parseFloat(fields.height.value) : 0,
        stand: { type: 'legs', color: fields.standColor.value },
      };
    };

    const refreshPreview = () => {
      const def = buildDef();
      const preview = $('gate-preview');
      preview.innerHTML = '';
      if (def.innerSize > 0 && def.tubeWidth > 0) {
        preview.appendChild(makeThumbnail(def, 64));
      }
      $('gate-file-hint').textContent = `gates/${def.id}.json`;
    };
    for (const f of Object.values(fields)) f.oninput = refreshPreview;

    // Field labels (and which fields apply at all) depend on the shape:
    // a pole has a height and diameter, not an opening and frame.
    const toggleRow = (labelId, input, show) => {
      $(labelId).classList.toggle('hidden', !show);
      input.classList.toggle('hidden', !show);
    };
    const applyShapeMeta = () => {
      const meta = shapeFieldMeta[fields.shape.value] || shapeFieldMeta.default;
      $('gate-inner-label').textContent = meta.inner;
      $('gate-tube-label').textContent = meta.tube;
      toggleRow('gate-depth-label', fields.depth, meta.showDepth);
      toggleRow('gate-height-label', fields.height, meta.showHeight);
      toggleRow('gate-stand-label', fields.standColor, meta.showLegs);
      fields.inner.value = String(meta.defaults.inner);
      fields.tube.value = String(meta.defaults.tube);
      refreshPreview();
    };
    fields.shape.onchange = applyShapeMeta;
    applyShapeMeta();

    $('gate-create').onclick = async () => {
      const def = buildDef();
      const problem = !def.name
        ? 'Name is required.'
        : !(def.innerSize > 0) || !(def.tubeWidth > 0) || !(def.depth > 0)
          ? 'Opening, frame width and frame depth must all be positive numbers.'
          : def.defaultHeight >= 0
            ? null
            : 'Default height must not be negative.';
      if (problem) {
        $('gate-error').textContent = problem;
        return;
      }
      try {
        await onCreate(def);
        this.closeDialogs();
      } catch (err) {
        $('gate-error').textContent = err.message;
      }
    };
    this.openDialog('dlg-gate');
  }

  openLoadDialog(tracks, { onLoad, onDelete }) {
    const list = $('track-list');
    list.innerHTML = '';
    if (!tracks.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No saved tracks yet.';
      list.appendChild(empty);
    }
    for (const t of tracks) {
      const row = document.createElement('div');
      row.className = 'track-row';
      const title = document.createElement('span');
      title.className = 'track-title';
      title.textContent = t.name || '(untitled)';
      title.addEventListener('click', () => {
        this.closeDialogs();
        onLoad(t.id);
      });
      const date = document.createElement('span');
      date.className = 'track-date';
      date.textContent = new Date(t.updated).toLocaleString();
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '✕';
      del.title = 'Delete this track';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete track "${t.name}"? This cannot be undone.`)) return;
        await onDelete(t.id);
        row.remove();
      });
      row.append(title, date, del);
      list.appendChild(row);
    }
    this.openDialog('dlg-load');
  }

  toast(msg, isError = false) {
    this.setStatus(isError ? `⚠ ${msg}` : msg);
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.setStatus(), 3000);
  }
}
