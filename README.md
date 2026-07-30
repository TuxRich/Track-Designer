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
  properties panel. `Ctrl+D` duplicates, `Del` deletes. Gates are numbered in
  track order — use the Order −/+ control (or type a position) in the panel
  to re-sequence them; everything renumbers automatically. Gate 1 is the
  start/finish and gets a chequered line on the floor beneath it, which moves
  if you reorder.
- **Replace** — the "Replace with…" dropdown in a gate's panel swaps it for a
  different gate type in the exact same spot, keeping its position, rotation,
  height, direction, prop status and sequence number.
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
- **Share** — 🔗 Share copies a view-only link (`?view=<id>`) to a saved
  track. Recipients can orbit, measure, and screenshot, but cannot move, add,
  or delete gates, and cannot save changes. Save the track first so it has an
  id to link to.
- **📷 Screenshot** — downloads a PNG of the current view.

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

- `shape` — `square`, `hex`, `circle`, `cube`, `pole`, `table`, or `banner`.
  New shape families are added in `web/js/gates.js` (`shapeBuilders` registry,
  one function per shape, plus optional form labels in `shapeFieldMeta`).
- A `banner` is a wide solid board (sponsor/club sign) you fly *over* — its
  arrow arcs over the top edge. `innerSize` is the width, `depth` the panel
  height, `defaultHeight` the bottom height (0 = on the floor, higher raises
  it on side posts).
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
```
