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
	// Private hides an unreleased track completely: it is left out of the
	// track list and its contents cannot be fetched without the track's
	// password (or the admin password).
	Private bool `json:"private,omitempty"`
}

// trackResponse is the client-facing shape — it exposes whether a track is
// protected but never the password hash.
type trackResponse struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Updated   time.Time       `json:"updated"`
	Data      json.RawMessage `json:"data,omitempty"`
	Protected bool            `json:"protected"`
	Private   bool            `json:"private"`
}

func (t *Track) response(includeData bool) trackResponse {
	r := trackResponse{
		ID:        t.ID,
		Name:      t.Name,
		Updated:   t.Updated,
		Protected: t.PasswordHash != "",
		Private:   t.Private,
	}
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
	Private   bool      `json:"private"`
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

func (s *TrackStore) isAdmin(provided string) bool {
	return s.adminPassword != "" &&
		subtle.ConstantTimeCompare([]byte(provided), []byte(s.adminPassword)) == 1
}

// authorize reports whether `provided` (the X-Track-Password header) may edit
// or delete `t`. Unprotected tracks are always editable; the admin password
// overrides any track password.
func (s *TrackStore) authorize(t *Track, provided string) bool {
	if t.PasswordHash == "" {
		return true
	}
	if s.isAdmin(provided) {
		return true
	}
	return provided != "" && verifyPassword(provided, t.PasswordHash)
}

// canView reports whether `t` may be listed or opened. Public tracks are open
// to everyone; a private (unreleased) track needs its own password or the
// admin password. A private track with no password of its own is admin-only.
func (s *TrackStore) canView(t *Track, provided string) bool {
	if !t.Private {
		return true
	}
	if s.isAdmin(provided) {
		return true
	}
	return t.PasswordHash != "" && provided != "" && verifyPassword(provided, t.PasswordHash)
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
	// A supplied password reveals the private tracks it unlocks (the admin
	// password reveals them all); everyone else never sees they exist.
	provided := r.Header.Get("X-Track-Password")
	summaries := []TrackSummary{}
	for _, p := range paths {
		id := filepath.Base(p)
		id = id[:len(id)-len(".json")]
		t, err := s.load(id)
		if err != nil {
			continue // skip unreadable files rather than failing the whole list
		}
		if !s.canView(t, provided) {
			continue
		}
		summaries = append(summaries, TrackSummary{
			ID:        t.ID,
			Name:      t.Name,
			Updated:   t.Updated,
			Protected: t.PasswordHash != "",
			Private:   t.Private,
		})
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
		Private  bool            `json:"private"`
	}
	if err := decodeBody(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if in.Name == "" {
		in.Name = "Untitled track"
	}
	// Without a password nobody (bar the admin) could ever open it again.
	if in.Private && in.Password == "" {
		writeError(w, http.StatusBadRequest, "a private track needs a password")
		return
	}
	t := &Track{ID: newID(), Name: in.Name, Updated: time.Now().UTC(), Data: in.Data, Private: in.Private}
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
	// Unreleased tracks can't be opened without the password.
	if !s.canView(t, r.Header.Get("X-Track-Password")) {
		writeError(w, http.StatusForbidden, "this track is private — enter its password to open it")
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
		// Pointer so an omitted field leaves the current setting alone — this
		// is how a track is released (private: false) or pulled back.
		Private *bool `json:"private"`
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
	private := existing.Private
	if in.Private != nil {
		private = *in.Private
	}
	if private && existing.PasswordHash == "" {
		writeError(w, http.StatusBadRequest, "a private track needs a password — save it as a new track with one")
		return
	}
	// Name/data are optional so a privacy-only change needn't resend the track.
	name := in.Name
	if name == "" {
		name = existing.Name
	}
	data := in.Data
	if len(data) == 0 {
		data = existing.Data
	}
	t := &Track{ID: id, Name: name, Updated: time.Now().UTC(), Data: data, PasswordHash: existing.PasswordHash, Private: private}
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
