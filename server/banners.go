package server

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Banners lists and serves the artwork images that can be placed on banner
// gates. Images live as plain files in the banners directory; drop a new
// image in and it appears as an option next time the New-gate form is opened.
type Banners struct {
	dir string
}

var bannerExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true,
}

func NewBanners(dir string) *Banners {
	return &Banners{dir: dir}
}

// HandleList returns the image filenames in the banners directory.
func (b *Banners) HandleList(w http.ResponseWriter, r *http.Request) {
	names := []string{}
	entries, err := os.ReadDir(b.dir)
	if err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			if bannerExts[strings.ToLower(filepath.Ext(e.Name()))] {
				names = append(names, e.Name())
			}
		}
	}
	sort.Strings(names)
	writeJSON(w, http.StatusOK, names)
}

// FileServer serves the banner images at /banners/<name>, guarding against
// path traversal outside the banners directory.
func (b *Banners) FileServer() http.Handler {
	fs := http.FileServer(http.Dir(b.dir))
	return http.StripPrefix("/banners/", fs)
}
