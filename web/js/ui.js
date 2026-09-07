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
    this.gateDefs = defs;
    const replace = $('prop-replace');
    replace.innerHTML = '<option value="">Replace with…</option>';
    for (const def of defs) {
      const opt = document.createElement('option');
      opt.value = def.id;
      opt.textContent = def.name;
      replace.appendChild(opt);
    }
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
      this.setStatus('Measuring — click points (gates snap at floor level, Shift-click for opening centre), Esc to finish a run');
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
    $('prop-order').addEventListener('change', () => {
      const entry = this.editor.selected;
      if (entry && !this._fillingProps) this.editor.reorderGate(entry, parseInt($('prop-order').value, 10));
    });
    $('prop-order-down').addEventListener('click', () => {
      const entry = this.editor.selected;
      if (entry) this.editor.reorderGate(entry, entry.number - 1);
    });
    $('prop-order-up').addEventListener('click', () => {
      const entry = this.editor.selected;
      if (entry) this.editor.reorderGate(entry, entry.number + 1);
    });
    $('prop-asgate').addEventListener('change', () => {
      const entry = this.editor.selected;
      if (entry && !this._fillingProps) this.editor.applyProps(entry, { prop: !$('prop-asgate').checked });
    });
    $('prop-replace').addEventListener('change', () => {
      const entry = this.editor.selected;
      const id = $('prop-replace').value;
      const def = this.gateDefs?.find((d) => d.id === id);
      if (entry && def && !this._fillingProps) this.editor.replaceGate(entry, def);
      $('prop-replace').value = '';
    });
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
    const count = this.editor.selection.length;
    if (count === 0) {
      panel.classList.add('hidden');
      return;
    }
    if (count > 1) {
      // Group selection: show a summary; Duplicate/Delete act on all of them.
      panel.classList.remove('hidden');
      $('prop-single').classList.add('hidden');
      $('prop-title').textContent = `${count} gates selected`;
      $('prop-hint').textContent = 'Drag to move, R to rotate the group, Esc to deselect';
      return;
    }
    $('prop-single').classList.remove('hidden');
    $('prop-hint').textContent = 'G = move, R = rotate, Esc = deselect';
    this._fillingProps = true;
    panel.classList.remove('hidden');
    const frame = entry.object.getObjectByName('frame');
    const isTable = !!frame?.userData.isTable;
    $('prop-title').textContent = `Gate ${entry.prop ? '(prop)' : entry.number} — ${entry.def.name}`;
    // "Use as gate" — unchecked means a prop, which drops out of the sequence.
    $('prop-asgate').checked = !entry.prop;
    const seqCount = this.editor.gates.filter((g) => !g.prop).length;
    $('prop-order-label').classList.toggle('hidden', entry.prop);
    $('prop-order-row').classList.toggle('hidden', entry.prop);
    $('prop-order').value = entry.number || 1;
    $('prop-order').max = seqCount;
    $('prop-x').value = entry.object.position.x.toFixed(2);
    $('prop-z').value = entry.object.position.z.toFixed(2);
    // For a table the height field is its own height, not a mount offset.
    const h = isTable ? entry.object.userData.tableHeight || 0 : entry.object.userData.height || 0;
    $('prop-h').value = h.toFixed(2);
    $('prop-rot').value = Math.round(THREE.MathUtils.radToDeg(entry.object.rotation.y));
    $('prop-replace').value = ''; // always reset to the "Replace with…" prompt
    // Poles have no fly-through direction. Planar gates get ⇄ Reverse;
    // multidirectional shapes (cube) get the full six-way dropdown. Props
    // aren't flown, so they show no direction control at all.
    const hasArrow = !!entry.object.getObjectByName('arrow') && !entry.prop;
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
    $('share-close').addEventListener('click', () => this.closeDialogs());
    $('save-cancel').addEventListener('click', () => this.closeDialogs());
    $('password-cancel').addEventListener('click', () => this.closeDialogs());
    $('liftoff-cancel').addEventListener('click', () => this.closeDialogs());
    $('glb-cancel').addEventListener('click', () => this.closeDialogs());
    $('btn-help').addEventListener('click', () => this.openDialog('dlg-help'));
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.closeDialogs();
    });
  }

  // Dialog to save the current design as a new track, with an optional
  // password. Calls onSave({ name, password }).
  openSaveDialog(currentName, onSave) {
    $('save-name').value = currentName || '';
    $('save-password').value = '';
    $('save-private').checked = false;
    $('save-error').textContent = '';
    this.openDialog('dlg-save');
    $('save-name').focus();
    $('save-name').select();
    $('save-confirm').onclick = () => {
      const name = $('save-name').value.trim() || 'Untitled track';
      const password = $('save-password').value;
      const isPrivate = $('save-private').checked;
      // Without a password a private track could never be reopened.
      if (isPrivate && !password) {
        $('save-error').textContent = 'A private track needs a password.';
        $('save-password').focus();
        return;
      }
      this.closeDialogs();
      onSave({ name, password, private: isPrivate });
    };
  }

  // Prompt for a password (to edit/delete a protected track, or the admin
  // password). Resolves to the entered string, or null if dismissed (Cancel,
  // Esc, or clicking outside — all routed through closeDialogs).
  askPassword(message) {
    return new Promise((resolve) => {
      $('password-msg').textContent = message;
      $('password-input').value = '';
      $('password-error').textContent = '';
      this.openDialog('dlg-password');
      $('password-input').focus();
      this._passwordResolve = resolve;
      const submit = () => this._submitPassword($('password-input').value);
      $('password-ok').onclick = submit;
      $('password-input').onkeydown = (e) => {
        if (e.key === 'Enter') submit();
      };
    });
  }

  _submitPassword(value) {
    const resolve = this._passwordResolve;
    this._passwordResolve = null;
    this.closeDialogs();
    resolve?.(value);
  }

  openDialog(id) {
    this.overlay.classList.remove('hidden');
    for (const dlg of this.overlay.querySelectorAll('.dialog')) {
      dlg.classList.toggle('hidden', dlg.id !== id);
    }
  }

  closeDialogs() {
    this.overlay.classList.add('hidden');
    // A password prompt dismissed by Esc/outside-click resolves as cancelled.
    if (this._passwordResolve) {
      const resolve = this._passwordResolve;
      this._passwordResolve = null;
      resolve(null);
    }
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
      image: $('gate-image'),
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

    // Banner artwork options come from the banners directory (via the server).
    fields.image.innerHTML = '<option value="">None (plain colour)</option>';
    for (const name of this.bannerImages || []) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      fields.image.appendChild(opt);
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
      const def = {
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
      if (meta.showImage && fields.image.value) def.image = fields.image.value;
      return def;
    };

    const refreshPreview = () => {
      const def = buildDef();
      const preview = $('gate-preview');
      preview.innerHTML = '';
      if (def.image) {
        const img = document.createElement('img');
        img.src = `/banners/${encodeURIComponent(def.image)}`;
        img.alt = def.image;
        preview.appendChild(img);
      } else if (def.innerSize > 0 && def.tubeWidth > 0) {
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
      $('gate-depth-label').textContent = meta.depthLabel || 'Frame depth (m)';
      $('gate-height-label').textContent = meta.heightLabel || 'Default height (m)';
      $('gate-stand-label').textContent = meta.legsLabel || 'Leg colour';
      toggleRow('gate-depth-label', fields.depth, meta.showDepth);
      toggleRow('gate-height-label', fields.height, meta.showHeight);
      toggleRow('gate-stand-label', fields.standColor, meta.showLegs);
      toggleRow('gate-image-label', fields.image, !!meta.showImage);
      fields.inner.value = String(meta.defaults.inner);
      fields.tube.value = String(meta.defaults.tube);
      if (meta.defaults.depth !== undefined) fields.depth.value = String(meta.defaults.depth);
      if (meta.defaults.height !== undefined) fields.height.value = String(meta.defaults.height);
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

  /**
   * Preview and export the current design as a Liftoff race.
   *
   * The preview is the point of the dialog. Liftoff has no whoop-sized gates,
   * so every gate is substituted for the nearest real prop and the layout is
   * scaled to suit — decisions worth seeing before you fly, since a gate that
   * comes out half the size of its neighbours reads as a bug in the air and is
   * very hard to diagnose from inside the game.
   *
   * @param {function} buildPreview (scale, poleTrigger) => convert result
   * @param {function} onDownload   (scale, poleTrigger) => void
   */
  openLiftoffDialog(buildPreview, onDownload) {
    const scaleSel = $('liftoff-scale');
    const poleInput = $('liftoff-pole');

    const refresh = () => {
      const scale = parseFloat(scaleSel.value);
      const pole = parseFloat(poleInput.value);
      let r;
      try {
        r = buildPreview(scale, Number.isFinite(pole) ? pole : undefined);
      } catch (err) {
        $('liftoff-warn').textContent = `Could not convert: ${err.message}`;
        $('liftoff-summary').innerHTML = '';
        return;
      }

      $('liftoff-arena').textContent =
        `${r.arena[0]} × ${r.arena[1]} m, ${r.checkpoints} checkpoints`;
      $('liftoff-warn').textContent = r.unknown.length
        ? `Unrecognised gate types, guessed as 0.75 m squares: ${r.unknown.join(', ')}`
        : '';

      const rows = r.summary.map((s) => {
        if (s.role === 'decoration') {
          return `<tr><td>${s.typeId}</td><td colspan="2">scenery</td>
                  <td>${s.item}</td></tr>`;
        }
        if (s.role === 'obstacle') {
          const t = s.trigger ? `${s.trigger.toFixed(1)} m trigger` : 'scenery';
          return `<tr><td>${s.typeId}</td><td>${s.want.toFixed(2)} m</td>
                  <td>${s.got.toFixed(2)} m</td><td>${t}</td></tr>`;
        }
        // Flag the ones worth arguing with: a substitution, or a poor fit.
        const cls = s.substituted ? 'error' : s.err > 20 ? 'error' : '';
        const note = s.substituted ? ' (shape swapped)' : '';
        return `<tr class="${cls}"><td>${s.typeId}</td><td>${s.want.toFixed(2)} m</td>
                <td>${s.got.toFixed(2)} m (${s.err.toFixed(0)}%)</td>
                <td>${s.item}${note}</td></tr>`;
      }).join('');

      $('liftoff-summary').innerHTML =
        `<table class="liftoff-table"><thead><tr><th>Designer</th><th>Wanted</th>
         <th>Got</th><th>Liftoff prop</th></tr></thead><tbody>${rows}</tbody></table>`;
    };

    scaleSel.onchange = refresh;
    poleInput.oninput = refresh;
    refresh();

    $('liftoff-download').onclick = () => {
      const pole = parseFloat(poleInput.value);
      onDownload(parseFloat(scaleSel.value),
                 Number.isFinite(pole) ? pole : undefined);
      this.closeDialogs();
    };
    this.openDialog('dlg-liftoff');
  }

  // Dialog for the .glb export. `getStats` previews the model for a set of
  // options; `onExport` does the work and may take a moment, so the button
  // reports progress rather than appearing to do nothing.
  openGlbDialog(getStats, onExport) {
    const ids = {
      floor: 'glb-floor',
      grid: 'glb-grid',
      arrows: 'glb-arrows',
      measurements: 'glb-measurements',
      labels: 'glb-labels',
    };
    const read = () =>
      Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, $(id).checked]));

    const refresh = () => {
      try {
        const { meshes, triangles } = getStats(read());
        $('glb-stats').textContent =
          `${meshes} objects, ${triangles.toLocaleString()} triangles`;
      } catch (err) {
        $('glb-stats').textContent = `could not preview: ${err.message}`;
      }
    };
    for (const id of Object.values(ids)) $(id).onchange = refresh;
    refresh();

    const button = $('glb-download');
    button.onclick = async () => {
      const label = button.textContent;
      button.disabled = true;
      button.textContent = 'Exporting…';
      try {
        await onExport(read());
        this.closeDialogs();
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    };
    this.openDialog('dlg-glb');
  }

  openShareDialog(url) {
    const input = $('share-url');
    const copyBtn = $('share-copy');
    input.value = url;
    copyBtn.textContent = 'Copy';
    this.openDialog('dlg-share');
    input.focus();
    input.select();
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        input.select();
        document.execCommand?.('copy'); // fallback for non-secure contexts
      }
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
    };
  }

  // Enter shared view-only mode: lock the track name and hide editing UI
  // (the rest is handled by CSS via the body.view-only class).
  setViewOnly(trackName) {
    document.body.classList.add('view-only');
    const nameInput = $('track-name');
    nameInput.value = trackName || 'Shared track';
    nameInput.readOnly = true;
  }

  openLoadDialog(tracks, { onLoad, onDelete, onUnlock, onTogglePrivate }, unlockPassword = '') {
    const list = $('track-list');
    $('load-password').value = unlockPassword;
    $('load-unlock-btn').onclick = () => onUnlock($('load-password').value);
    $('load-password').onkeydown = (e) => {
      if (e.key === 'Enter') onUnlock($('load-password').value);
    };
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
      // 🚧 marks an unreleased (private) track, 🔒 one that needs a password
      // to edit or delete.
      title.textContent = `${t.private ? '🚧 ' : ''}${t.protected ? '🔒 ' : ''}${t.name || '(untitled)'}`;
      title.title = t.private
        ? 'Private — hidden from everyone without the password until you release it'
        : t.protected
          ? 'Password-protected — anyone can load it, but editing or deleting needs the password'
          : 'Load this track';
      title.addEventListener('click', () => {
        this.closeDialogs();
        onLoad(t.id);
      });
      const date = document.createElement('span');
      date.className = 'track-date';
      date.textContent = new Date(t.updated).toLocaleString();
      // Release an unreleased track, or pull a public one back into private.
      const privacy = document.createElement('button');
      privacy.textContent = t.private ? 'Release' : 'Unlist';
      privacy.title = t.private
        ? 'Make this track public — everyone will be able to see and load it'
        : 'Make this track private again (needs a password on the track)';
      privacy.addEventListener('click', () => onTogglePrivate(t));

      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '✕';
      del.title = 'Delete this track';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete track "${t.name}"? This cannot be undone.`)) return;
        if (await onDelete(t)) row.remove();
      });
      row.append(title, date, privacy, del);
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
