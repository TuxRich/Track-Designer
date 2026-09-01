# FPV Track Designer

A web app for designing FPV racing tracks in 3D — built for whoop racing, but any
gate size works. Lay out gates in a defined space, measure the distances between
them, and screenshot the result so you can build the track in real life.

Backend is Go (stdlib only); frontend is Three.js (vendored, no build step).

## Run

```
go run .
```

Then open <http://localhost:8080>.

Flags:

| Flag | Default | Purpose |
|---|---|---|
| `-addr` | `:8080` | Listen address |
| `-gates` | `gates` | Directory of gate type definitions |
| `-tracks` | `data/tracks` | Directory where saved tracks are stored |
| `-dev` | off | Serve the frontend from `./web` on disk instead of the copy embedded in the binary (use while editing frontend code) |

`go build` produces a single self-contained binary — the frontend is embedded.
Only the `gates/` folder (and a writable tracks directory) needs to ship with it.

## Using the designer

- **Place gates** — click a gate type in the palette, then click the floor.
  Stay in placement mode to drop several; `Esc` to stop.
- **Edit a gate** — click it (the middle of the opening works). Drag the gizmo
  to move, `G`/`R` to switch move/rotate, or type exact numbers in the
  properties panel. `Ctrl+D` duplicates, `Del` deletes. **Shift/Ctrl-click**
  adds or removes gates from a multi-selection — drag or rotate the gizmo to
  move/rotate them all as a group (rotation is around the group's centre);
  `Ctrl+D`/`Del` act on the whole selection. Gates are numbered in
  track order — use the Order −/+ control (or type a position) in the panel
  to re-sequence them; everything renumbers automatically. Gate 1 is the
  start/finish and gets a chequered line on the floor beneath it, which moves
  if you reorder.
- **Replace** — the "Replace with…" dropdown in a gate's panel swaps it for a
  different gate type in the exact same spot, keeping its position, rotation,
  height, direction, prop status and sequence number.
- **Gates in the same spot** — when two or more gates share a position (e.g. a
  cube flown through twice on different routes), their numbers are stacked at
  different heights so they don't overlay, and each number is colour-matched to
  its own direction arrows (yellow, pink, green, …) so you can tell which way
  to fly for which number. Move them apart and they revert to normal.
- **Props** — uncheck "Use as gate" in a gate's panel (the default for tables)
  to make it a prop: it stays in the scene and you can still move, measure to,
  and screenshot it, but it gets no number, no direction arrow, and isn't part
  of the flight sequence. Handy for tables you stand gates on.
- **Measure** — toggle 📏 Measure (or `M`), click points; clicking a gate snaps
  to its spot on the floor, so the numbers match a tape measure laid on the
  ground (Shift-click a gate for a 3D distance from its opening centre
  instead). Each segment is labelled in meters and the running
  total shows in the toolbar. `Esc` finishes a run; measurements stay visible
  (they save with the track and appear in screenshots) until you hit Clear.
  Click any measurement point to edit it: drag the gizmo to move it (labels
  update live), `Del` removes it. The 👁 button hides/shows all measurements,
  e.g. for a clean screenshot.
- **Direction arrows** — every gate shows a yellow arrow for the direction to
  fly through it (poles excluded). ⇄ Reverse in the gate's panel flips it;
  cube gates instead get **In through** / **Out through** face choices
  (front/back/left/right/top/bottom). Opposite faces draw one straight arrow;
  any other combination draws two arrows meeting in the cube's center — e.g.
  in the top, out the front. The same cube type can be used differently at
  different points in a track. The ➤ toolbar button hides/shows all arrows,
  and each gate's route saves with the track.
- **Arena** — set the width/depth/height of your space. The grid has 0.5 m
  minor and 1 m major lines with meter numbers along two edges; coordinates
  are meters from the arena corner.
- **Save / Load** — tracks are stored server-side as JSON in `data/tracks/`.
- **Passwords** — **Save As** creates a new track and can set a password on it.
  Anyone can load a protected track (🔒 in the Load list) and use **Save As**
  to keep their own copy, but overwriting or deleting the original requires its
  password. Passwords are stored salted and stretched (never in plain text) and
  are never sent to clients; the server enforces this on every write.
- **Admin master password** — start the server with `-admin-password <pw>` (or
  set `TRACK_ADMIN_PASSWORD`) to be able to edit or delete any track without
  knowing its password. Enter it wherever a track password is asked for.
- **Share** — 🔗 Share copies a view-only link (`?view=<id>`) to a saved
  track. Recipients can orbit, measure, and screenshot, but cannot move, add,
  or delete gates, and cannot save changes. Save the track first so it has an
  id to link to.
- **📷 Screenshot** — downloads a PNG of the current view.
- **🚁 Liftoff** — exports the track as a playable [Liftoff](https://store.steampowered.com/app/410340/)
  race. See below.

## Export to Liftoff

**🚁 Liftoff** converts the track you are looking at into a playable Liftoff
race and downloads it as a zip. It works on the in-memory design, so unsaved
edits are included — you do not have to save first.

Extract the zip over your Liftoff folder and restart the game:

```
%USERPROFILE%\AppData\LocalLow\LuGus Studios\Liftoff\
```

The archive already has the right shape, so there is nothing to rename:

```
Tracks/<track-guid>/<track-guid>_0001.track     geometry: props, checkpoints, spawn
Races/<race-guid>/<race-guid>_0001.race         ordering: which checkpoint, in what order
```

GUIDs are derived from the track id and scale, so exporting the same track
again **replaces** that copy rather than adding another entry to Liftoff's
already crowded track list.

### Why it scales the layout up

Whoop courses are 5–10 m rooms with 0.5–0.75 m gates. The smallest gate prop in
Liftoff is about 1.10 m, so a 1:1 rebuild has a mean aperture error of 107% —
every gate roughly twice the size it should be. Scaling is forced, not a
preference. ×2 is the default and lands gates on 1.52 m, exactly what a real 5"
course uses; ×4 matches apertures more closely on paper but oversizes
everything. The dialog shows the resulting arena size as you change it.

### Read the preview

Before downloading, the dialog lists every gate: what size the designer asked
for, which real Liftoff prop it got, the error, and whether the *shape* had to
be swapped (flagged in red). Substitutions happen when a prop would come out
conspicuously smaller than the track's other gates — a gate at half the size of
its neighbours reads as a bug in the air and is very hard to diagnose from
inside the game.

Gates are matched by `shape` and `innerSize`, not by `typeId`, so gate types you
invent with **＋ New gate type** export correctly with no code changes. Anything
genuinely unrecognised is called out rather than silently becoming a default.

The **flag margin** field controls how much room you get either side of a slalom
pole. Poles are rotationally symmetric, so their trigger is squared to the
direction of travel worked out from the neighbouring gates, not to the pole's own
rotation.

### Implementation

`web/js/liftoff/` — plain ES modules, no build step, no dependencies, in keeping
with the rest of the frontend. Nothing server-side is involved.

| File | |
|---|---|
| `convert.js` | designer document → Liftoff geometry |
| `catalog.js` | the real Liftoff prop catalogue and how gates are matched to it |
| `xml.js` | `.track` / `.race` writers |
| `uuid5.js` | deterministic GUIDs (self-contained SHA-1, so no secure-context requirement) |
| `zip.js` | minimal store-only zip writer |
| `export.js` | entry point |

`web/liftoff-test.html` is a standalone harness with embedded fixtures and
self-checks — open it with the server running to exercise the exporter without
designing anything.

The conversion rules were worked out against Liftoff's file format and a corpus
of Steam Workshop tracks in a separate project, which keeps a Python
implementation and asserts the two produce byte-identical output.

## Adding a gate type

The easy way: click **＋ New gate type** under the palette. The form (with a
live preview) writes the JSON file to `gates/` on the server and adds the gate
to the palette immediately — no restart.

Or drop a JSON file in `gates/` yourself and restart the server:

```json
{
  "id": "square-75",
  "name": "Square Gate 0.75m",
  "shape": "square",
  "innerSize": 0.75,
  "tubeWidth": 0.05,
  "depth": 0.04,
  "color": "#ffd400",
  "defaultHeight": 0,
  "stand": { "type": "legs", "color": "#333333" }
}
```

- `shape` — `square`, `hex`, `circle`, `cube`, `pole`, `table`, `chair`, or
  `banner`. New shape families are added in `web/js/gates.js` (`shapeBuilders`
  registry, one function per shape, plus optional form labels in
  `shapeFieldMeta`).
- A `chair` is a floor prop (seat on legs with a backrest): `innerSize` = seat
  width, `depth` = seat depth, `defaultHeight` = seat height. Like tables, it
  defaults to a prop.
- A `banner` is a wide solid board (sponsor/club sign) you fly *over* — its
  arrow arcs over the top edge. `innerSize` is the width, `depth` the panel
  height, `defaultHeight` the bottom height (0 = on the floor, higher raises
  it on side posts). An optional `image` field names an artwork file in the
  `banners/` directory (see below) to display on the panel.

### Banner artwork

Drop image files (`.jpg/.jpeg/.png/.webp/.gif`) into the `banners/` directory.
When you create a banner in the New-gate form, an "Image" picker lists them and
the chosen artwork is stretched across the panel. The server lists them at
`GET /api/banners` and serves them from `/banners/<file>`. Like `gates/`, this
folder is read from disk at runtime (not embedded), so it must ship alongside
the binary; override its location with `-banners <dir>`.
- A `table` is a solid prop (tabletop on legs) — `innerSize` is its width,
  `depth` its depth, `defaultHeight` its height. Tables default to props (see
  below); set `propByDefault` in `shapeFieldMeta` to change that per shape.
- `innerSize` — the opening, meters (flat-to-flat for hex, diameter for
  circle). For a `pole` this is the pole's height, and `tubeWidth` is its
  diameter.
- `tubeWidth` / `depth` — frame thickness and depth, meters.
- `defaultHeight` — how far off the floor the gate bottom sits when first
  placed (stand legs are drawn automatically whenever height > 0).

## Layout

```
main.go            server entry: routes, go:embed of web/
server/gates.go    loads gates/*.json, GET /api/gates
server/tracks.go   track CRUD, JSON files in data/tracks/
gates/             gate type definitions (edit these!)
web/               frontend (vanilla JS modules + vendored Three.js)
web/js/liftoff/    Liftoff exporter (self-contained, no dependencies)
```
