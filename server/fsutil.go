package server

import (
	"os"
	"path/filepath"
)

// writeFileAtomic replaces path with data so that a reader — or the server
// after a crash — sees either the old file or the new one, never a
// half-written mix. It writes a temporary file in the same directory, flushes
// it to disk, then renames it over the target (rename is atomic within one
// filesystem).
//
// The temporary name deliberately doesn't end in ".json", so the "*.json"
// globs that discover tracks and gate types never pick up a leftover one.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// Clean up the temp file on any failure; after a successful rename it no
	// longer exists under this name, so the Remove is a harmless no-op.
	defer os.Remove(tmpName)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
