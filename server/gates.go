package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
)

// GateType is a parametric gate definition loaded from a JSON file in the
// gates directory. All dimensions are in meters. The frontend builds the 3D
// geometry from these parameters, so adding a new gate type only requires
// dropping a new JSON file in the directory and restarting the server — or
// creating one through POST /api/gates, which writes the file and registers
// the type without a restart.
type GateType struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Shape         string  `json:"shape"`
	InnerSize     float64 `json:"innerSize"`
	TubeWidth     float64 `json:"tubeWidth"`
	Depth         float64 `json:"depth"`
	Color         string  `json:"color"`
	DefaultHeight float64 `json:"defaultHeight"`
	// Image is an optional banner artwork filename in the banners directory,
	// served at /banners/<image>. Used by banner gates for sponsor/club art.
	Image string          `json:"image,omitempty"`
	Stand json.RawMessage `json:"stand,omitempty"`
}

// GateRegistry holds all gate types loaded at startup plus any created at
// runtime via the API.
type GateRegistry struct {
	mu    sync.RWMutex
	dir   string
	Types []GateType
}

// LoadGates reads every *.json file in dir as a GateType.
func LoadGates(dir string) (*GateRegistry, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	reg := &GateRegistry{dir: dir}
	seen := map[string]string{}
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		var gt GateType
		if err := json.Unmarshal(data, &gt); err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		if gt.ID == "" || gt.Shape == "" {
			return nil, fmt.Errorf("%s: gate definition must have id and shape", p)
		}
		if prev, dup := seen[gt.ID]; dup {
			return nil, fmt.Errorf("%s: duplicate gate id %q (already defined in %s)", p, gt.ID, prev)
		}
		seen[gt.ID] = p
		reg.Types = append(reg.Types, gt)
	}
	sort.Slice(reg.Types, func(i, j int) bool { return reg.Types[i].Name < reg.Types[j].Name })
	return reg, nil
}

func (g *GateRegistry) HandleList(w http.ResponseWriter, r *http.Request) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	writeJSON(w, http.StatusOK, g.Types)
}

var validGateID = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

func validateGate(gt *GateType) error {
	switch {
	case !validGateID.MatchString(gt.ID):
		return fmt.Errorf("id must be lowercase letters, digits, - or _ (got %q)", gt.ID)
	case gt.Name == "":
		return fmt.Errorf("name is required")
	case gt.Shape == "":
		return fmt.Errorf("shape is required")
	case gt.InnerSize <= 0:
		return fmt.Errorf("innerSize must be > 0")
	case gt.TubeWidth <= 0:
		return fmt.Errorf("tubeWidth must be > 0")
	case gt.Depth < 0 || gt.DefaultHeight < 0:
		return fmt.Errorf("depth and defaultHeight must not be negative")
	}
	return nil
}

// HandleCreate persists a new gate type as <id>.json in the gates directory
// and registers it immediately (no restart needed).
func (g *GateRegistry) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var gt GateType
	if err := decodeBody(r, &gt); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateGate(&gt); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, t := range g.Types {
		if t.ID == gt.ID {
			writeError(w, http.StatusConflict, fmt.Sprintf("a gate type with id %q already exists", gt.ID))
			return
		}
	}
	data, err := json.MarshalIndent(gt, "", "  ")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.WriteFile(filepath.Join(g.dir, gt.ID+".json"), data, 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	g.Types = append(g.Types, gt)
	sort.Slice(g.Types, func(i, j int) bool { return g.Types[i].Name < g.Types[j].Name })
	writeJSON(w, http.StatusCreated, gt)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// headers already sent; nothing useful to do beyond logging via the default logger
		return
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
