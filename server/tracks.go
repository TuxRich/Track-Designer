package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
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
	"strconv"
	"strings"
	"sync"
	"time"
)

// Track is stored verbatim as JSON on disk. Data holds the full document the
// frontend round-trips (arena size, gates, measurements, ...). PasswordHash,
// when set, protects the track: editing or deleting it requires the password
// (or the admin password). The hash is never sent to clients.
type Track struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Updated      time.Time       `json:"updated"`
	Data         json.RawMessage `json:"data"`
	PasswordHash string          `json:"passwordHash,omitempty"`
}

// trackResponse is the client-facing shape — it exposes whether a track is
// protected but never the password hash.
type trackResponse struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Updated   time.Time       `json:"updated"`
	Data      json.RawMessage `json:"data,omitempty"`
	Protected bool            `json:"protected"`
}

func (t *Track) response(includeData bool) trackResponse {
	r := trackResponse{ID: t.ID, Name: t.Name, Updated: t.Updated, Protected: t.PasswordHash != ""}
	if includeData {
		r.Data = t.Data
	}
	return r
}

// TrackSummary is what the list endpoint returns.
type TrackSummary struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Updated   time.Time `json:"updated"`
	Protected bool      `json:"protected"`
}

// TrackStore persists tracks as individual JSON files in a directory.
type TrackStore struct {
	dir           string
	adminPassword string // master password; empty disables admin override
	mu            sync.Mutex
}

var validID = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func NewTrackStore(dir, adminPassword string) (*TrackStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &TrackStore{dir: dir, adminPassword: adminPassword}, nil
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

// ---------- password hashing (stdlib: salted, stretched SHA-256) ----------

const pwIterations = 100000

func stretch(pw string, salt []byte, iters int) []byte {
	h := sha256.Sum256(append(append([]byte{}, salt...), []byte(pw)...))
	out := h[:]
	for i := 0; i < iters; i++ {
		next := sha256.Sum256(append(append([]byte{}, out...), salt...))
		out = next[:]
	}
	return out
}

func hashPassword(pw string) string {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	h := stretch(pw, salt, pwIterations)
	return fmt.Sprintf("%d$%s$%s", pwIterations, hex.EncodeToString(salt), hex.EncodeToString(h))
}

func verifyPassword(pw, stored string) bool {
	parts := strings.SplitN(stored, "$", 3)
	if len(parts) != 3 {
		return false
	}
	iters, err := strconv.Atoi(parts[0])
	if err != nil {
		return false
	}
	salt, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}
	want, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(stretch(pw, salt, iters), want) == 1
}

// authorize reports whether `provided` (the X-Track-Password header) may edit
// or delete `t`. Unprotected tracks are always editable; the admin password
// overrides any track password.
func (s *TrackStore) authorize(t *Track, provided string) bool {
	if t.PasswordHash == "" {
		return true
	}
	if s.adminPassword != "" && subtle.ConstantTimeCompare([]byte(provided), []byte(s.adminPassword)) == 1 {
		return true
	}
	return provided != "" && verifyPassword(provided, t.PasswordHash)
}

// ---------- handlers ----------

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
		summaries = append(summaries, TrackSummary{ID: t.ID, Name: t.Name, Updated: t.Updated, Protected: t.PasswordHash != ""})
	}
	sort.Slice(summaries, func(i, j int) bool { return summaries[i].Updated.After(summaries[j].Updated) })
	writeJSON(w, http.StatusOK, summaries)
}

// HandleCreate makes a new track. Anyone may create one; an optional password
// protects it against later edits/deletes.
func (s *TrackStore) HandleCreate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name     string          `json:"name"`
		Data     json.RawMessage `json:"data"`
		Password string          `json:"password"`
	}
	if err := decodeBody(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if in.Name == "" {
		in.Name = "Untitled track"
	}
	t := &Track{ID: newID(), Name: in.Name, Updated: time.Now().UTC(), Data: in.Data}
	if in.Password != "" {
		t.PasswordHash = hashPassword(in.Password)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.save(t); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, t.response(false))
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
	writeJSON(w, http.StatusOK, t.response(true))
}

// HandleUpdate overwrites an existing track. If it is protected, the request
// must carry the matching password (or the admin password) in the
// X-Track-Password header. Protection is preserved across updates.
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
	existing, err := s.load(id)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "track not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !s.authorize(existing, r.Header.Get("X-Track-Password")) {
		writeError(w, http.StatusForbidden, "wrong password")
		return
	}
	t := &Track{ID: id, Name: in.Name, Updated: time.Now().UTC(), Data: in.Data, PasswordHash: existing.PasswordHash}
	if err := s.save(t); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, t.response(false))
}

func (s *TrackStore) HandleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validID.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid track id")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, err := s.load(id)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "track not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !s.authorize(existing, r.Header.Get("X-Track-Password")) {
		writeError(w, http.StatusForbidden, "wrong password")
		return
	}
	if err := os.Remove(s.path(id)); err != nil {
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
