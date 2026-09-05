package server

import (
	"compress/gzip"
	"net/http"
	"path"
	"strings"
)

// Formats that are already compressed — gzipping them just burns CPU.
var incompressible = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true,
	".woff": true, ".woff2": true, ".zip": true, ".mp4": true,
}

// Gzip compresses text responses (HTML/CSS/JS/JSON) for clients that accept
// it. It matters here because the vendored Three.js build is by far the
// largest asset — a few hundred KB compressed instead of ~1.3 MB raw.
func Gzip(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") ||
			incompressible[strings.ToLower(path.Ext(r.URL.Path))] {
			h.ServeHTTP(w, r)
			return
		}
		// Byte ranges can't be served from a compressed stream.
		r.Header.Del("Range")
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")

		gz := gzip.NewWriter(w)
		gw := &gzipWriter{ResponseWriter: w, gz: gz}
		h.ServeHTTP(gw, r)
		if !gw.bodyless {
			gz.Close()
		}
	})
}

type gzipWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
	// Set for statuses that carry no body (304/204); those must not get a
	// gzip header written into them.
	bodyless bool
}

func (w *gzipWriter) WriteHeader(status int) {
	// The compressed body won't match the declared length.
	w.Header().Del("Content-Length")
	if status == http.StatusNotModified || status == http.StatusNoContent {
		w.bodyless = true
		w.Header().Del("Content-Encoding")
		w.Header().Del("Vary")
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *gzipWriter) Write(b []byte) (int, error) {
	if w.bodyless {
		return w.ResponseWriter.Write(b)
	}
	return w.gz.Write(b)
}
