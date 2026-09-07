import { api } from './api.js';
import { SceneManager } from './scene.js';
import { Editor } from './editor.js';
import { MeasureTool } from './measure.js';
import { UI } from './ui.js';
import { downloadLiftoffZip } from './liftoff/export.js';
import { convert as convertLiftoff } from './liftoff/convert.js';
import { VRMode } from './vr.js';

const $ = (id) => document.getElementById(id);

const state = { mode: 'select' }; // select | place | measure

const sceneMgr = new SceneManager($('canvas3d'));
const editor = new Editor(sceneMgr, state);
const measure = new MeasureTool(sceneMgr, editor, state);
const ui = new UI(editor, measure, sceneMgr, state);
const vr = new VRMode(sceneMgr, editor);

// Measurement points sit on top of gates (often exactly at a gate's center),
// so clicks on them take priority over gate selection.
editor.prePick = (e) => measure.visible && !!measure.pickMarkerAt(e);

let gateDefs = [];
let defsById = {};
let currentTrackId = null;

const viewTrackId = new URLSearchParams(location.search).get('view');

// Dismiss the boot overlay shown in index.html. Called once the palette is up
// (or on failure, so it can never leave the app stuck behind a spinner).
function hideBootOverlay(errorMessage) {
  clearTimeout(window.bootTimer);
  const boot = $('boot');
  if (!boot) return;
  if (errorMessage) {
    const msg = $('boot-msg');
    msg.textContent = errorMessage;
    msg.classList.add('error');
    return; // leave it up: without gate types there's nothing to design with
  }
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 300); // after the fade
}

async function init() {
  try {
    gateDefs = await api.gates();
    defsById = Object.fromEntries(gateDefs.map((d) => [d.id, d]));
    ui.buildPalette(gateDefs);
  } catch (err) {
    ui.toast(`Failed to load gate types: ${err.message}`, true);
    hideBootOverlay(`Could not load gate types: ${err.message}`);
    return;
  }
  hideBootOverlay();
  // Banner artwork options for the New-gate form (best-effort).
  ui.bannerImages = await api.banners().catch(() => []);
  if (viewTrackId) enterViewMode(viewTrackId);
}

// Shared view-only link: load the track and lock all gate editing. Viewers
// can still measure and screenshot, but cannot move/add/delete or save gates.
async function enterViewMode(id) {
  editor.readOnly = true;
  let t;
  try {
    t = await api.getTrack(id);
  } catch (err) {
    if (err.status !== 403) {
      ui.toast(`Could not open shared track: ${err.message}`, true);
      return;
    }
    // A shared link to a track that hasn't been released yet.
    const pw = await ui.askPassword('This shared track is private and not released yet. Enter its password (or the admin password) to view it.');
    if (pw === null) return;
    try {
      t = await api.getTrack(id, pw);
    } catch (err2) {
      ui.toast(err2.status === 403 ? 'Wrong password — track not opened.' : `Could not open shared track: ${err2.message}`, true);
      return;
    }
  }
  loadTrackData(t.data);
  ui.setViewOnly(t.name);
  ui.toast(`Viewing shared track "${t.name}"`);
}

// ---------- track document ----------

function trackData() {
  return {
    arena: { ...sceneMgr.arena },
    gates: editor.toJSON(),
    measurements: measure.toJSON(),
  };
}

function loadTrackData(data) {
  const arena = data?.arena || { w: 10, d: 8, h: 3 };
  sceneMgr.setArena(arena.w, arena.d, arena.h);
  sceneMgr.resetCamera();
  editor.loadFrom(data?.gates, defsById);
  measure.loadFrom(data?.measurements);
}

// Password for the currently-loaded protected track, remembered for this
// session so you only type it once per track.
let currentPassword = '';
let currentProtected = false;

// Overwrite the loaded track, prompting for its password if the server says
// it's protected (the track's own password or the admin one both work).
async function saveTrack() {
  const name = $('track-name').value.trim() || 'Untitled track';
  if (!currentTrackId) return saveTrackAs(); // nothing loaded — save as new
  try {
    await api.updateTrack(currentTrackId, name, trackData(), currentPassword);
    ui.toast(`Saved "${name}"`);
    return;
  } catch (err) {
    if (err.status !== 403) {
      ui.toast(`Save failed: ${err.message}`, true);
      return;
    }
  }
  // Protected: ask for the password and retry once.
  const pw = await ui.askPassword(`"${name}" is password-protected. Enter its password (or the admin password) to overwrite it — or cancel and use Save As.`);
  if (pw === null) return;
  try {
    await api.updateTrack(currentTrackId, name, trackData(), pw);
    currentPassword = pw; // remember for later saves this session
    ui.toast(`Saved "${name}"`);
  } catch (err) {
    ui.toast(err.status === 403 ? 'Wrong password — track not saved.' : `Save failed: ${err.message}`, true);
  }
}

// Always create a new track, optionally protected with a password.
function saveTrackAs() {
  ui.openSaveDialog($('track-name').value.trim(), async ({ name, password, private: isPrivate }) => {
    try {
      const t = await api.createTrack(name, trackData(), password, isPrivate);
      currentTrackId = t.id;
      currentPassword = password || '';
      currentProtected = !!t.protected;
      $('track-name').value = name;
      const how = isPrivate ? ' 🚧 (private — hidden until you release it)' : password ? ' (password protected)' : '';
      ui.toast(`Saved "${name}"${how}`);
    } catch (err) {
      ui.toast(`Save failed: ${err.message}`, true);
    }
  });
}

// Open a track. Private ones need a password, so retry once after asking.
async function loadTrack(id, password = '') {
  let t;
  try {
    t = await api.getTrack(id, password);
  } catch (err) {
    if (err.status !== 403) {
      ui.toast(`Load failed: ${err.message}`, true);
      return;
    }
    const pw = await ui.askPassword('This track is private and not released yet. Enter its password (or the admin password) to open it.');
    if (pw === null) return;
    try {
      t = await api.getTrack(id, pw);
      password = pw;
    } catch (err2) {
      ui.toast(err2.status === 403 ? 'Wrong password — track not opened.' : `Load failed: ${err2.message}`, true);
      return;
    }
  }
  currentTrackId = t.id;
  currentPassword = password; // reuse for saving if it's also the edit password
  currentProtected = !!t.protected;
  $('track-name').value = t.name;
  loadTrackData(t.data);
  const how = t.private ? ' 🚧 (private)' : t.protected ? ' 🔒 (protected — Save As to keep your own copy)' : '';
  ui.toast(`Loaded "${t.name}"${how}`);
}

// Delete a track, prompting for a password if it's protected. Returns true
// when it was actually removed.
async function deleteTrack(t) {
  const pw = t.protected
    ? await ui.askPassword(`"${t.name}" is password-protected. Enter its password (or the admin password) to delete it.`)
    : '';
  if (pw === null) return false;
  try {
    await api.deleteTrack(t.id, pw);
    if (t.id === currentTrackId) currentTrackId = null;
    ui.toast(`Deleted "${t.name}"`);
    return true;
  } catch (err) {
    ui.toast(err.status === 403 ? 'Wrong password — track not deleted.' : `Delete failed: ${err.message}`, true);
    return false;
  }
}

function newTrack() {
  currentTrackId = null;
  currentPassword = '';
  currentProtected = false;
  $('track-name').value = '';
  editor.clearAll();
  measure.clearAll();
}

// ---------- toolbar ----------

$('btn-new').addEventListener('click', () => {
  if (editor.gates.length && !confirm('Start a new track? Unsaved changes will be lost.')) return;
  newTrack();
});

$('btn-save').addEventListener('click', saveTrack);
$('btn-saveas').addEventListener('click', saveTrackAs);

// Open the Load dialog. `password` (if given) also reveals the private tracks
// it unlocks — the admin password reveals them all.
async function openLoadDialog(password = '') {
  try {
    const tracks = await api.listTracks(password);
    ui.openLoadDialog(
      tracks,
      {
        onLoad: (id) => loadTrack(id, password),
        onDelete: deleteTrack,
        onUnlock: (pw) => openLoadDialog(pw),
        onTogglePrivate: (t) => toggleTrackPrivacy(t, password),
      },
      password
    );
  } catch (err) {
    ui.toast(`Could not list tracks: ${err.message}`, true);
  }
}

// Release an unreleased track (or pull a public one back), then refresh the list.
async function toggleTrackPrivacy(t, listPassword) {
  const target = !t.private;
  let pw = listPassword;
  try {
    await api.setTrackPrivacy(t.id, target, pw);
  } catch (err) {
    if (err.status !== 403) {
      ui.toast(err.message, true);
      return;
    }
    const asked = await ui.askPassword(`Enter the password for "${t.name}" (or the admin password) to ${target ? 'make it private' : 'release it'}.`);
    if (asked === null) return;
    pw = asked;
    try {
      await api.setTrackPrivacy(t.id, target, pw);
    } catch (err2) {
      ui.toast(err2.status === 403 ? 'Wrong password — nothing changed.' : err2.message, true);
      return;
    }
  }
  ui.toast(target ? `"${t.name}" is now private` : `"${t.name}" is now public`);
  openLoadDialog(listPassword); // refresh the list in place
}

$('btn-load').addEventListener('click', () => openLoadDialog());

$('btn-share').addEventListener('click', () => {
  if (!currentTrackId) {
    ui.toast('Save your track first, then share it.', true);
    return;
  }
  const url = `${location.origin}${location.pathname}?view=${currentTrackId}`;
  ui.openShareDialog(url);
});

$('btn-measure').addEventListener('click', () => {
  ui.setMeasureActive(state.mode !== 'measure');
});

$('btn-clear-measure').addEventListener('click', () => measure.clearAll());

$('btn-arena').addEventListener('click', () => {
  ui.openArenaDialog((w, d, h) => {
    sceneMgr.setArena(w, d, h);
    sceneMgr.resetCamera();
  });
});

$('btn-screenshot').addEventListener('click', () => {
  const url = sceneMgr.screenshotPNG();
  const a = document.createElement('a');
  const name = ($('track-name').value.trim() || 'track') .replace(/[^\w-]+/g, '_');
  a.href = url;
  a.download = `${name}.png`;
  a.click();
});

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke once the browser has taken the blob, not before.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Export the design as a playable Liftoff race. This runs on the in-memory
// document, so unsaved edits are included — you do not have to save first.
function exportLiftoff() {
  const src = {
    id: currentTrackId || 'unsaved',
    name: $('track-name').value.trim() || 'Untitled track',
    data: trackData(),
  };
  const opts = (scale, poleTrigger) => ({
    scale, ...(poleTrigger === undefined ? {} : { poleTrigger }),
  });
  ui.openLiftoffDialog(
    (scale, poleTrigger) => convertLiftoff(src, defsById, opts(scale, poleTrigger)),
    (scale, poleTrigger) => {
      const { filename } = downloadLiftoffZip(src, defsById, opts(scale, poleTrigger));
      ui.toast(`Exported ${filename} — extract it over your Liftoff folder`);
    },
  );
}

// Export the placed gates as a USDZ model for Quick Look / AR. The exporter is
// loaded on demand so its ~100 KB never lands on the normal page load.
function exportUSDZModel() {
  ui.openUSDZDialog(async (includeArrows) => {
    const { exportUSDZ } = await import('./export/usdz.js');
    const name = $('track-name').value.trim() || 'track';
    const { blob, filename, meshes } = await exportUSDZ(editor.gates, { name, includeArrows });
    saveBlob(blob, filename);
    ui.toast(`Exported ${filename} (${meshes} parts)`);
  });
}

// Export the design as a .glb model — real metres, unlike the Liftoff export.
// Loaded on demand so GLTFExporter (~81 KB) stays off the initial page load.
async function exportGLBModel() {
  const { downloadGLB, exportStats } = await import('./export3d.js');
  ui.openGlbDialog(
    (opts) => exportStats(sceneMgr, editor, measure, opts),
    async (opts) => {
      const name = $('track-name').value.trim() || 'track';
      try {
        const { filename, bytes } = await downloadGLB(name, sceneMgr, editor, measure, opts);
        ui.toast(`Exported ${filename} (${(bytes / 1e6).toFixed(1)} MB)`);
      } catch (err) {
        ui.toast(`Export failed: ${err.message}`, true);
      }
    },
  );
}

$('btn-export').addEventListener('click', () => {
  if (!editor.gates.length) {
    ui.toast('Nothing to export — place some gates first.', true);
    return;
  }
  ui.openExportDialog({
    onLiftoff: exportLiftoff,
    onGLB: exportGLBModel,
    onUSDZ: exportUSDZModel,
  });
});

// The VR button stays hidden unless a headset can actually be driven, so it
// never offers something that would only fail.
vr.onChange = (active) => $('btn-vr').classList.toggle('active', active);
VRMode.isSupported().then((supported) => {
  if (supported) $('btn-vr').classList.remove('hidden');
});

$('btn-vr').addEventListener('click', async () => {
  if (!vr.active) {
    // Placement and measuring are pointer tools with no VR equivalent.
    ui.setMeasureActive(false);
    editor.cancelPlacement();
  }
  try {
    await vr.toggle();
  } catch (err) {
    ui.toast(`Could not start VR: ${err.message}`, true);
  }
});

$('chk-snap').addEventListener('change', (e) => editor.setSnap(e.target.checked));

$('btn-new-gate').addEventListener('click', () => {
  ui.openGateDialog(async (def) => {
    const created = await api.createGate(def);
    gateDefs.push(created);
    gateDefs.sort((a, b) => a.name.localeCompare(b.name));
    defsById[created.id] = created;
    ui.buildPalette(gateDefs);
    ui.toast(`Gate type "${created.name}" created`);
  });
});

// ---------- keyboard ----------

window.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

  if (e.key === 'Escape') {
    if (ui.dialogOpen) return ui.closeDialogs();
    if (state.mode === 'place') return editor.cancelPlacement();
    if (measure.selected) return measure.deselectMarker();
    if (state.mode === 'measure') return ui.setMeasureActive(false);
    editor.deselect();
    return;
  }
  if (typing) return;

  if (e.ctrlKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!editor.readOnly) saveTrack();
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    editor.duplicateSelected();
    return;
  }
  switch (e.key.toLowerCase()) {
    case 'g':
      editor.setTransformMode('translate');
      break;
    case 'r':
      editor.setTransformMode('rotate');
      break;
    case 'm':
      ui.setMeasureActive(state.mode !== 'measure');
      break;
    case 'delete':
    case 'backspace':
      if (measure.selected) measure.deleteSelectedPoint();
      else editor.deleteSelected();
      break;
  }
});

init();

// Handy for debugging from the browser console.
window.trackDesigner = { state, sceneMgr, editor, measure, vr };
