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
//
// Locking: mu guards the files. Reads hold it shared and writes exclusively,
// and both hold it only for file I/O — never while checking a password.
// Password checks are deliberately slow, so doing one under the lock would
// let a single client's guessing stall every other request.
type TrackStore struct {
	dir           string
	adminPassword string // master password; empty disables admin override
	mu            sync.RWMutex
}

// historyKeep is how many earlier versions of each track are kept.
const historyKeep = 20

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

// historyDir holds earlier versions of one track. It lives in a dot-folder
// alongside the tracks, so the "*.json" glob that lists tracks never sees it.
func (s *TrackStore) historyDir(id string) string {
	return filepath.Join(s.dir, ".history", id)
}

// load reads one track. The caller holds s.mu.
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

// loadShared reads one track, holding the lock only for the read.
func (s *TrackStore) loadShared(id string) (*Track, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.load(id)
}

// loadAll reads every track, skipping unreadable files rather than failing
// the whole list. The lock is held only for the reads.
func (s *TrackStore) loadAll() ([]*Track, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	paths, err := filepath.Glob(filepath.Join(s.dir, "*.json"))
	if err != nil {
		return nil, err
	}
	tracks := make([]*Track, 0, len(paths))
	for _, p := range paths {
		id := strings.TrimSuffix(filepath.Base(p), ".json")
		if t, err := s.load(id); err == nil {
			tracks = append(tracks, t)
		}
	}
	return tracks, nil
}

// save writes a track atomically. The caller holds s.mu for writing.
func (s *TrackStore) save(t *Track) error {
	data, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(s.path(t.ID), data)
}

// backup copies the current version of a track into its history folder before
// it is overwritten or deleted, so a bad save or deliberate vandalism can be
// undone by copying the file back. The raw file is kept as-is, password hash
// included, so a restored track keeps its protection. Only the newest
// historyKeep versions are kept. The caller holds s.mu for writing.
func (s *TrackStore) backup(id string) error {
	data, err := os.ReadFile(s.path(id))
	if err != nil {
		return err
	}
	dir := s.historyDir(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// Fixed-width UTC timestamps sort chronologically as plain strings.
	name := time.Now().UTC().Format("20060102T150405.000000000Z") + ".json"
	if err := writeFileAtomic(filepath.Join(dir, name), data); err != nil {
		return err
	}
	versions, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return err
	}
	sort.Strings(versions)
	for len(versions) > historyKeep {
		if err := os.Remove(versions[0]); err != nil {
			return err
		}
		versions = versions[1:]
	}
	return nil
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

// maxPwIterations caps the work a stored hash can demand, so a corrupted or
// hand-edited track file can't make one password check run for minutes.
const maxPwIterations = 5_000_000

// stretch computes SHA256(salt || pw), then repeatedly SHA256(prev || salt).
// It reuses one buffer rather than allocating on each of the ~100,000 rounds;
// the output is unchanged, so existing hashes still verify.
func stretch(pw string, salt []byte, iters int) []byte {
	first := make([]byte, 0, len(salt)+len(pw))
	first = append(first, salt...)
	first = append(first, pw...)
	sum := sha256.Sum256(first)

	buf := make([]byte, sha256.Size+len(salt))
	copy(buf[sha256.Size:], salt)
	for i := 0; i < iters; i++ {
		copy(buf[:sha256.Size], sum[:])
		sum = sha256.Sum256(buf)
	}
	return sum[:]
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
	if err != nil || iters < 1 || iters > maxPwIterations {
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

// authorize reports whether `provided` (the X-Track-Password header) may
// overwrite `t`. Unprotected tracks are editable by anyone — that's what an
// open track is for, and every overwrite is backed up. The admin password
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

// canDelete is stricter than authorize: an unprotected track can only be
// deleted by the admin. Otherwise anyone could list every open track and
// delete them all in a couple of requests.
func (s *TrackStore) canDelete(t *Track, provided string) bool {
	if s.isAdmin(provided) {
		return true
	}
	return t.PasswordHash != "" && provided != "" && verifyPassword(provided, t.PasswordHash)
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
	tracks, err := s.loadAll()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// A supplied password reveals the private tracks it unlocks (the admin
	// password reveals them all); everyone else never sees they exist. These
	// checks run after the lock is released.
	provided := r.Header.Get("X-Track-Password")
	summaries := []TrackSummary{}
	for _, t := range tracks {
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
		t.PasswordHash = hashPassword(in.Password) // slow: done before locking
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.save(t); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, t.response(false))
}

// loadForHandler loads a track for a request, writing the error response
// itself when it can't. It returns nil when the request is already answered.
func (s *TrackStore) loadForHandler(w http.ResponseWriter, id string) *Track {
	if !validID.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid track id")
		return nil
	}
	t, err := s.loadShared(id)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "track not found")
		return nil
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return nil
	}
	return t
}

func (s *TrackStore) HandleGet(w http.ResponseWriter, r *http.Request) {
	t := s.loadForHandler(w, r.PathValue("id"))
	if t == nil {
		return
	}
	// Unreleased tracks can't be opened without the password.
	if !s.canView(t, r.Header.Get("X-Track-Password")) {
		writeError(w, http.StatusForbidden, "this track is private — enter its password to open it")
		return
	}
	writeJSON(w, http.StatusOK, t.response(true))
}

// reloadForWrite re-reads a track under the write lock, after its password
// was checked without the lock. The password hash is fixed when a track is
// created, so an unchanged hash means that check still holds; a change is
// only possible by editing files on disk, and is refused rather than guessed
// at. The caller holds s.mu for writing. Returns nil if already answered.
func (s *TrackStore) reloadForWrite(w http.ResponseWriter, checked *Track) *Track {
	current, err := s.load(checked.ID)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "track not found")
		return nil
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return nil
	}
	if current.PasswordHash != checked.PasswordHash {
		writeError(w, http.StatusConflict, "the track's password changed — reload and try again")
		return nil
	}
	return current
}

// HandleUpdate overwrites an existing track. If it is protected, the request
// must carry the matching password (or the admin password) in the
// X-Track-Password header. Protection is preserved across updates, and the
// previous version is backed up first.
func (s *TrackStore) HandleUpdate(w http.ResponseWriter, r *http.Request) {
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
	checked := s.loadForHandler(w, r.PathValue("id"))
	if checked == nil {
		return
	}
	if !s.authorize(checked, r.Header.Get("X-Track-Password")) {
		writeError(w, http.StatusForbidden, "wrong password")
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.reloadForWrite(w, checked)
	if current == nil {
		return
	}
	private := current.Private
	if in.Private != nil {
		private = *in.Private
	}
	if private && current.PasswordHash == "" {
		writeError(w, http.StatusBadRequest, "a private track needs a password — save it as a new track with one")
		return
	}
	// Name/data are optional so a privacy-only change needn't resend the track.
	name := in.Name
	if name == "" {
		name = current.Name
	}
	data := in.Data
	if len(data) == 0 {
		data = current.Data
	}
	if err := s.backup(current.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not back up the previous version: "+err.Error())
		return
	}
	t := &Track{ID: current.ID, Name: name, Updated: time.Now().UTC(), Data: data, PasswordHash: current.PasswordHash, Private: private}
	if err := s.save(t); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, t.response(false))
}

// HandleDelete removes a track, keeping a copy in its history folder.
// A protected track needs its password (or the admin's); an unprotected one
// can only be deleted by the admin.
func (s *TrackStore) HandleDelete(w http.ResponseWriter, r *http.Request) {
	checked := s.loadForHandler(w, r.PathValue("id"))
	if checked == nil {
		return
	}
	if !s.canDelete(checked, r.Header.Get("X-Track-Password")) {
		msg := "wrong password"
		if checked.PasswordHash == "" {
			msg = "only the admin can delete a track that has no password"
		}
		writeError(w, http.StatusForbidden, msg)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reloadForWrite(w, checked) == nil {
		return
	}
	if err := s.backup(checked.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not back up the track before deleting it: "+err.Error())
		return
	}
	if err := os.Remove(s.path(checked.ID)); err != nil {
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
