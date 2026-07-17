package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

// Track is stored verbatim as JSON on disk. The server only cares about the
// identifying fields; Data holds the full document the frontend round-trips
// (arena size, gates, measurements, ...).
type Track struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Updated time.Time       `json:"updated"`
	Data    json.RawMessage `json:"data"`
}

// TrackSummary is what the list endpoint returns.
type TrackSummary struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Updated time.Time `json:"updated"`
}

// TrackStore persists tracks as individual JSON files in a directory.
type TrackStore struct {
	dir string
	mu  sync.Mutex
}

var validID = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func NewTrackStore(dir string) (*TrackStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &TrackStore{dir: dir}, nil
}

func (s *TrackStore) path(id string) string {
	return filepath.Join(s.dir, id+".json")
}

func (s *TrackStore) load(id string) (*Track, error) {
	data, err := os.ReadFile(s.path(id))
	if err != nil {
		return nil, err
	}
	var t Track
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *TrackStore) save(t *Track) error {
	data, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path(t.ID), data, 0o644)
}

func newID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("t%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func (s *TrackStore) HandleList(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	paths, err := filepath.Glob(filepath.Join(s.dir, "*.json"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	summaries := []TrackSummary{}
	for _, p := range paths {
		id := filepath.Base(p)
		id = id[:len(id)-len(".json")]
		t, err := s.load(id)
		if err != nil {
			continue // skip unreadable files rather than failing the whole list
		}
		summaries = append(summaries, TrackSummary{ID: t.ID, Name: t.Name, Updated: t.Updated})
	}
	sort.Slice(summaries, func(i, j int) bool { return summaries[i].Updated.After(summaries[j].Updated) })
	writeJSON(w, http.StatusOK, summaries)
}

func (s *TrackStore) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string          `json:"name"`
		Data json.RawMessage `json:"data"`
	}
	if err := decodeBody(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if in.Name == "" {
		in.Name = "Untitled track"
	}
	t := &Track{ID: newID(), Name: in.Name, Updated: time.Now().UTC(), Data: in.Data}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.save(t); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, t)
}

func (s *TrackStore) HandleGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid track id")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := s.load(id)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "track not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *TrackStore) HandleUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid track id")
		return
	}
	var in struct {
		Name string          `json:"name"`
		Data json.RawMessage `json:"data"`
	}
	if err := decodeBody(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.load(id); errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "track not found")
		return
	}
	t := &Track{ID: id, Name: in.Name, Updated: time.Now().UTC(), Data: in.Data}
	if err := s.save(t); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *TrackStore) HandleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid track id")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(s.path(id)); errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "track not found")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func decodeBody(r *http.Request, v any) error {
	defer r.Body.Close()
	data, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return errors.New("empty request body")
	}
	return json.Unmarshal(data, v)
}
