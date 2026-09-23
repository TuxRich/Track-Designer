package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testAdmin = "admin-pw"

func newTestStore(t *testing.T) (*TrackStore, http.Handler) {
	t.Helper()
	s, err := NewTrackStore(t.TempDir(), testAdmin)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/tracks", s.HandleList)
	mux.HandleFunc("POST /api/tracks", s.HandleCreate)
	mux.HandleFunc("GET /api/tracks/{id}", s.HandleGet)
	mux.HandleFunc("PUT /api/tracks/{id}", s.HandleUpdate)
	mux.HandleFunc("DELETE /api/tracks/{id}", s.HandleDelete)
	return s, mux
}

func do(t *testing.T, h http.Handler, method, path, password, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if password != "" {
		req.Header.Set("X-Track-Password", password)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// create makes a track and returns its id.
func create(t *testing.T, h http.Handler, name, password string, private bool) string {
	t.Helper()
	body := fmt.Sprintf(`{"name":%q,"data":{"gates":[]},"password":%q,"private":%t}`, name, password, private)
	rec := do(t, h, "POST", "/api/tracks", "", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create %q: got %d %s", name, rec.Code, rec.Body)
	}
	var out struct{ ID string }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.ID
}

func historyFiles(t *testing.T, s *TrackStore, id string) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(s.historyDir(id), "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// ---------- hashing ----------

// stretchOriginal is the implementation every existing stored hash was made
// with. It is kept only as the reference the faster version must match.
func stretchOriginal(pw string, salt []byte, iters int) []byte {
	h := sha256.Sum256(append(append([]byte{}, salt...), []byte(pw)...))
	out := h[:]
	for i := 0; i < iters; i++ {
		next := sha256.Sum256(append(append([]byte{}, out...), salt...))
		out = next[:]
	}
	return out
}

func TestStretchMatchesOriginal(t *testing.T) {
	salt := []byte("0123456789abcdef")
	for _, pw := range []string{"", "a", "correct horse battery staple", "ünïcødé 🚁"} {
		for _, iters := range []int{0, 1, 2, 1000} {
			got := hex.EncodeToString(stretch(pw, salt, iters))
			want := hex.EncodeToString(stretchOriginal(pw, salt, iters))
			if got != want {
				t.Errorf("stretch(%q, %d) = %s, want %s", pw, iters, got, want)
			}
		}
	}
}

// A hash written before the optimisation must still verify after it —
// otherwise every protected track would be locked out.
func TestHashFromOriginalCodeStillVerifies(t *testing.T) {
	salt := []byte("fedcba9876543210")
	stored := fmt.Sprintf("%d$%s$%s", pwIterations, hex.EncodeToString(salt),
		hex.EncodeToString(stretchOriginal("club-secret", salt, pwIterations)))
	if !verifyPassword("club-secret", stored) {
		t.Fatal("hash made by the original stretch no longer verifies")
	}
	if verifyPassword("wrong", stored) {
		t.Fatal("wrong password verified")
	}
}

func TestVerifyRejectsAbsurdIterationCounts(t *testing.T) {
	for _, iters := range []string{"0", "-5", "999999999999"} {
		stored := iters + "$00$00"
		start := time.Now()
		if verifyPassword("x", stored) {
			t.Errorf("iters=%s: verified", iters)
		}
		if d := time.Since(start); d > 100*time.Millisecond {
			t.Errorf("iters=%s: took %v, should be rejected up front", iters, d)
		}
	}
}

// ---------- fix 1: deleting open tracks ----------

func TestOpenTrackCanOnlyBeDeletedByAdmin(t *testing.T) {
	s, h := newTestStore(t)
	id := create(t, h, "open", "", false)

	rec := do(t, h, "DELETE", "/api/tracks/"+id, "", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("anonymous delete of open track: got %d, want 403", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "only the admin") {
		t.Errorf("unhelpful message: %s", rec.Body)
	}
	if rec := do(t, h, "DELETE", "/api/tracks/"+id, "guess", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("delete with a non-admin password: got %d, want 403", rec.Code)
	}
	if rec := do(t, h, "GET", "/api/tracks/"+id, "", ""); rec.Code != http.StatusOK {
		t.Fatalf("track should still exist, got %d", rec.Code)
	}

	if rec := do(t, h, "DELETE", "/api/tracks/"+id, testAdmin, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("admin delete: got %d %s", rec.Code, rec.Body)
	}
	if n := len(historyFiles(t, s, id)); n != 1 {
		t.Errorf("deleted track should leave 1 backup, found %d", n)
	}
}

func TestProtectedTrackDeleteNeedsItsPassword(t *testing.T) {
	_, h := newTestStore(t)
	id := create(t, h, "locked", "pw", false)
	if rec := do(t, h, "DELETE", "/api/tracks/"+id, "nope", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("wrong password: got %d", rec.Code)
	}
	if rec := do(t, h, "DELETE", "/api/tracks/"+id, "pw", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("right password: got %d %s", rec.Code, rec.Body)
	}
}

// Open tracks stay editable by anyone — that's the feature — but the version
// being replaced is kept, so an overwrite can be undone.
func TestOverwriteKeepsPreviousVersion(t *testing.T) {
	s, h := newTestStore(t)
	id := create(t, h, "original name", "", false)

	rec := do(t, h, "PUT", "/api/tracks/"+id, "", `{"name":"vandalised","data":{"gates":["junk"]}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("anonymous overwrite of open track: got %d %s", rec.Code, rec.Body)
	}
	files := historyFiles(t, s, id)
	if len(files) != 1 {
		t.Fatalf("want 1 backup, found %d", len(files))
	}
	backup, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(backup), "original name") {
		t.Errorf("backup should hold the pre-overwrite version, got %s", backup)
	}
}

func TestBackupKeepsProtectionAndIsPruned(t *testing.T) {
	s, h := newTestStore(t)
	id := create(t, h, "v0", "pw", false)
	for i := 1; i <= historyKeep+5; i++ {
		body := fmt.Sprintf(`{"name":"v%d","data":{}}`, i)
		if rec := do(t, h, "PUT", "/api/tracks/"+id, "pw", body); rec.Code != http.StatusOK {
			t.Fatalf("update %d: got %d %s", i, rec.Code, rec.Body)
		}
	}
	files := historyFiles(t, s, id)
	if len(files) != historyKeep {
		t.Fatalf("want %d backups after pruning, found %d", historyKeep, len(files))
	}
	newest, _ := os.ReadFile(files[len(files)-1])
	if !strings.Contains(string(newest), `"passwordHash"`) {
		t.Error("backups must keep the password hash, or a restored track loses its protection")
	}
	// The history folder must not show up as a track.
	var list []TrackSummary
	json.Unmarshal(do(t, h, "GET", "/api/tracks", "", "").Body.Bytes(), &list)
	if len(list) != 1 {
		t.Errorf("list should show 1 track, got %d", len(list))
	}
}

// ---------- fix 2: password checks must not block other requests ----------

func TestPasswordChecksDoNotBlockOtherRequests(t *testing.T) {
	_, h := newTestStore(t)
	for i := 0; i < 20; i++ {
		create(t, h, fmt.Sprintf("private-%d", i), fmt.Sprintf("pw-%d", i), true)
	}
	public := create(t, h, "public", "", false)

	// Time a password-bearing list on its own: one check per private track.
	start := time.Now()
	do(t, h, "GET", "/api/tracks", "a guess", "")
	listTook := time.Since(start)

	// Run that list in the background, and time an unrelated read meanwhile.
	done := make(chan struct{})
	go func() {
		do(t, h, "GET", "/api/tracks", "another guess", "")
		close(done)
	}()
	time.Sleep(listTook / 5) // let the list get well into its password checks
	start = time.Now()
	if rec := do(t, h, "GET", "/api/tracks/"+public, "", ""); rec.Code != http.StatusOK {
		t.Fatalf("public read: %d", rec.Code)
	}
	readTook := time.Since(start)
	<-done

	t.Logf("password list %v, concurrent public read %v", listTook, readTook)
	if readTook > listTook/4 {
		t.Errorf("public read took %v while a %v password list ran — it is being blocked", readTook, listTook)
	}
}

// ---------- fix 4: resilience to bad files ----------

func TestLoadGatesSkipsBadFilesInsteadOfFailing(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("good.json", `{"id":"good","name":"Good","shape":"square","innerSize":0.5,"tubeWidth":0.04}`)
	write("truncated.json", `{"id":"half","name":"Ha`) // as left by an interrupted write
	write("noshape.json", `{"id":"noshape","name":"No shape"}`)
	write("dupe.json", `{"id":"good","name":"Dupe","shape":"hex","innerSize":0.5,"tubeWidth":0.04}`)

	reg, err := LoadGates(dir)
	if err != nil {
		t.Fatalf("one bad file must not stop the server: %v", err)
	}
	if len(reg.Types) != 1 || reg.Types[0].ID != "good" {
		t.Fatalf("want just the good gate, got %+v", reg.Types)
	}
}

func TestUnreadableTrackIsSkippedNotFatal(t *testing.T) {
	s, h := newTestStore(t)
	create(t, h, "fine", "", false)
	os.WriteFile(filepath.Join(s.dir, "broken.json"), []byte(`{"id":"broken","na`), 0o644)

	rec := do(t, h, "GET", "/api/tracks", "", "")
	var list []TrackSummary
	json.Unmarshal(rec.Body.Bytes(), &list)
	if rec.Code != http.StatusOK || len(list) != 1 {
		t.Fatalf("list should still work and show the good track: %d %s", rec.Code, rec.Body)
	}
}

func TestWriteFileAtomicReplacesAndLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t.json")
	for _, content := range []string{"first", "second"} {
		if err := writeFileAtomic(path, []byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := os.ReadFile(path)
	if string(got) != "second" {
		t.Errorf("content = %q, want %q", got, "second")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("want only t.json, found %v", names)
	}
}
