package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"

	"track-designer/server"
)

//go:embed web
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	gatesDir := flag.String("gates", "gates", "directory containing gate type definitions (*.json)")
	tracksDir := flag.String("tracks", "data/tracks", "directory for saved tracks")
	dev := flag.Bool("dev", false, "serve the frontend from ./web on disk instead of the embedded copy")
	flag.Parse()

	gates, err := server.LoadGates(*gatesDir)
	if err != nil {
		log.Fatalf("loading gates: %v", err)
	}
	log.Printf("loaded %d gate types from %s", len(gates.Types), *gatesDir)

	tracks, err := server.NewTrackStore(*tracksDir)
	if err != nil {
		log.Fatalf("initialising track store: %v", err)
	}

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

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/gates", gates.HandleList)
	mux.HandleFunc("POST /api/gates", gates.HandleCreate)
	mux.HandleFunc("GET /api/tracks", tracks.HandleList)
	mux.HandleFunc("POST /api/tracks", tracks.HandleCreate)
	mux.HandleFunc("GET /api/tracks/{id}", tracks.HandleGet)
	mux.HandleFunc("PUT /api/tracks/{id}", tracks.HandleUpdate)
	mux.HandleFunc("DELETE /api/tracks/{id}", tracks.HandleDelete)
	files := http.FileServerFS(static)
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Revalidate on every request so frontend updates are picked up
		// immediately after a server rebuild.
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))

	log.Printf("track designer listening on http://localhost%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
