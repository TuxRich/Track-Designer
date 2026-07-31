import { api } from './api.js';
import { SceneManager } from './scene.js';
import { Editor } from './editor.js';
import { MeasureTool } from './measure.js';
import { UI } from './ui.js';

const $ = (id) => document.getElementById(id);

const state = { mode: 'select' }; // select | place | measure

const sceneMgr = new SceneManager($('canvas3d'));
const editor = new Editor(sceneMgr, state);
const measure = new MeasureTool(sceneMgr, editor, state);
const ui = new UI(editor, measure, sceneMgr, state);

// Measurement points sit on top of gates (often exactly at a gate's center),
// so clicks on them take priority over gate selection.
editor.prePick = (e) => measure.visible && !!measure.pickMarkerAt(e);

let gateDefs = [];
let defsById = {};
let currentTrackId = null;

const viewTrackId = new URLSearchParams(location.search).get('view');

async function init() {
  try {
    gateDefs = await api.gates();
    defsById = Object.fromEntries(gateDefs.map((d) => [d.id, d]));
    ui.buildPalette(gateDefs);
  } catch (err) {
    ui.toast(`Failed to load gate types: ${err.message}`, true);
    return;
  }
  // Banner artwork options for the New-gate form (best-effort).
  ui.bannerImages = await api.banners().catch(() => []);
  if (viewTrackId) enterViewMode(viewTrackId);
}

// Shared view-only link: load the track and lock all gate editing. Viewers
// can still measure and screenshot, but cannot move/add/delete or save gates.
async function enterViewMode(id) {
  editor.readOnly = true;
  try {
    const t = await api.getTrack(id);
    loadTrackData(t.data);
    ui.setViewOnly(t.name);
    ui.toast(`Viewing shared track "${t.name}"`);
  } catch (err) {
    ui.toast(`Could not open shared track: ${err.message}`, true);
  }
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

async function saveTrack() {
  const name = $('track-name').value.trim() || 'Untitled track';
  try {
    if (currentTrackId) {
      await api.updateTrack(currentTrackId, name, trackData());
    } else {
      const t = await api.createTrack(name, trackData());
      currentTrackId = t.id;
    }
    ui.toast(`Saved "${name}"`);
  } catch (err) {
    ui.toast(`Save failed: ${err.message}`, true);
  }
}

async function loadTrack(id) {
  try {
    const t = await api.getTrack(id);
    currentTrackId = t.id;
    $('track-name').value = t.name;
    loadTrackData(t.data);
    ui.toast(`Loaded "${t.name}"`);
  } catch (err) {
    ui.toast(`Load failed: ${err.message}`, true);
  }
}

function newTrack() {
  currentTrackId = null;
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

$('btn-load').addEventListener('click', async () => {
  try {
    const tracks = await api.listTracks();
    ui.openLoadDialog(tracks, {
      onLoad: loadTrack,
      onDelete: async (id) => {
        await api.deleteTrack(id);
        if (id === currentTrackId) currentTrackId = null;
      },
    });
  } catch (err) {
    ui.toast(`Could not list tracks: ${err.message}`, true);
  }
});

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
window.trackDesigner = { state, sceneMgr, editor, measure };
