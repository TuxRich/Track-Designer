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
  properties panel. `Ctrl+D` duplicates, `Del` deletes.
- **Measure** — toggle 📏 Measure (or `M`), click points; clicking a gate snaps
  to its opening centre. Each segment is labelled in meters and the running
  total shows in the toolbar. `Esc` finishes a run; measurements stay visible
  (they save with the track and appear in screenshots) until you hit Clear.
  Click any measurement point to edit it: drag the gizmo to move it (labels
  update live), `Del` removes it. The 👁 button hides/shows all measurements,
  e.g. for a clean screenshot.
- **Arena** — set the width/depth/height of your space. The grid has 0.5 m
  minor and 1 m major lines with meter numbers along two edges; coordinates
  are meters from the arena corner.
- **Save / Load** — tracks are stored server-side as JSON in `data/tracks/`.
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

- `shape` — `square`, `hex`, `circle`, or `pole`. New shape families are added
  in `web/js/gates.js` (`shapeBuilders` registry, one function per shape, plus
  optional form labels in `shapeFieldMeta`).
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
