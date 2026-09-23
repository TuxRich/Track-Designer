package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	"track-designer/server"
)

//go:embed web
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	gatesDir := flag.String("gates", "gates", "directory containing gate type definitions (*.json)")
	tracksDir := flag.String("tracks", "data/tracks", "directory for saved tracks")
	bannersDir := flag.String("banners", "banners", "directory of banner artwork images")
	adminPassword := flag.String("admin-password", os.Getenv("TRACK_ADMIN_PASSWORD"),
		"master password to edit/delete any track (defaults to $TRACK_ADMIN_PASSWORD)")
	dev := flag.Bool("dev", false, "serve the frontend from ./web on disk instead of the embedded copy")
	trustProxy := flag.Bool("trust-proxy", false,
		"identify clients by X-Forwarded-For / X-Real-IP for rate limiting (only behind a reverse proxy you control)")
	flag.Parse()

	gates, err := server.LoadGates(*gatesDir)
	if err != nil {
		log.Fatalf("loading gates: %v", err)
	}
	log.Printf("loaded %d gate types from %s", len(gates.Types), *gatesDir)

	tracks, err := server.NewTrackStore(*tracksDir, *adminPassword)
	if err != nil {
		log.Fatalf("initialising track store: %v", err)
	}
	if *adminPassword != "" {
		log.Print("admin master password is set")
	}

	banners := server.NewBanners(*bannersDir)

	var static fs.FS
	if *dev {
		static = os.DirFS("web")
		log.Print("dev mode: serving frontend from ./web")
	} else {
		static, err = fs.Sub(webFS, "web")
		if err != nil {
			log.Fatal(err)
		}
	}

	// API data changes on every edit, so it must never be cached. Without
	// explicit headers a browser may cache a GET heuristically and serve a
	// stale track after a save — making the save look like it was lost.
	noStore := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
			w.Header().Set("Pragma", "no-cache")
			w.Header().Set("Expires", "0")
			h(w, r)
		}
	}

	// Requests carrying a track password: 20 at once per client, then one
	// every two seconds. Ordinary browsing never sends a password, so is never
	// throttled; this only slows down password guessing.
	pwLimit := server.NewPasswordLimiter(20, 2*time.Second, *trustProxy)
	track := func(h http.HandlerFunc) http.HandlerFunc { return noStore(pwLimit.Wrap(h)) }

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/gates", noStore(gates.HandleList))
	mux.HandleFunc("POST /api/gates", noStore(gates.HandleCreate))
	mux.HandleFunc("GET /api/tracks", track(tracks.HandleList))
	mux.HandleFunc("POST /api/tracks", noStore(tracks.HandleCreate))
	mux.HandleFunc("GET /api/tracks/{id}", track(tracks.HandleGet))
	mux.HandleFunc("PUT /api/tracks/{id}", track(tracks.HandleUpdate))
	mux.HandleFunc("DELETE /api/tracks/{id}", track(tracks.HandleDelete))
	mux.HandleFunc("GET /api/banners", noStore(banners.HandleList))
	mux.Handle("GET /banners/", banners.FileServer())
	files := http.FileServerFS(static)
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Revalidate on every request so frontend updates are picked up
		// immediately after a server rebuild.
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))

	log.Printf("track designer listening on http://localhost%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, server.Gzip(mux)))
}
