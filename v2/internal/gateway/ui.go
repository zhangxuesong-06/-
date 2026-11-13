package gateway

import (
	_ "embed"
	"strings"
)

//go:embed ui.html
var uiHTML string

//go:embed assets/workbuddy.png
var workbuddyPNG []byte

func (s *Server) page() string {
	return strings.ReplaceAll(uiHTML, "__APX_TOKEN__", s.cfg.Token)
}
