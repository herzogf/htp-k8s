package server

import (
	"embed"
	"io/fs"
)

// distFS embeds the built frontend so the binary can serve it directly,
// with no external file dependencies at runtime (ADR-0001).
//
// The dist/ directory here is populated by copying the real frontend build
// output (web/dist, built via `npm run build`) as part of `task build` (see
// the root Taskfile). A minimal placeholder dist/index.html is checked into
// version control so `go build`/`go vet`/`go test` succeed even without a
// frontend build having run first — go:embed requires the pattern to match
// at least one file at compile time, and can't reach outside this package's
// own directory tree (so it can't reference web/dist directly). The real
// build output overwrites the placeholder.
//
//go:embed all:dist
var distFS embed.FS

// frontendFS returns the embedded frontend build output rooted at its
// content root (stripping the "dist/" embed prefix), ready to be served
// directly at "/".
func frontendFS() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		// Unreachable: "dist" is a literal, always-embedded directory.
		panic(err)
	}
	return sub
}
