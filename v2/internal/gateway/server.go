package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"apx2/internal/config"
	"apx2/internal/harness"
	"apx2/internal/router"
	"apx2/internal/upstream"
)

type Server struct {
	cfg config.Config
	rt  *router.Router
	up  *upstream.Client
	sem chan struct{}

	started time.Time

	mu     sync.Mutex
	recent []RequestRecord
	reqs   int
	errs   int
	tokens int64
	lastAt time.Time
}

type RequestRecord struct {
	At         string `json:"at"`
	Path       string `json:"path"`
	Model      string `json:"model,omitempty"`
	Provider   string `json:"provider,omitempty"`
	Group      string `json:"group,omitempty"`
	Stream     bool   `json:"stream"`
	Status     int    `json:"status"`
	MS         int64  `json:"ms"`
	InputChars int    `json:"inputChars,omitempty"`
	Tokens     int    `json:"tokens,omitempty"`
	Code       string `json:"code,omitempty"`
	Error      string `json:"error,omitempty"`
}

func New(cfg config.Config, rt *router.Router) *Server {
	return &Server{
		cfg:     cfg,
		rt:      rt,
		up:      upstream.NewClient(time.Duration(cfg.TimeoutSeconds) * time.Second),
		sem:     make(chan struct{}, max(1, cfg.Limits.MaxConcurrent)),
		started: time.Now(),
	}
}

func (s *Server) Handler() http.Handler { return http.HandlerFunc(s.serveHTTP) }

func (s *Server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		writeError(w, http.StatusForbidden, "apx_cors_denied", "CORS preflight denied")
		return
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" || r.Header.Get("Origin") == "null" {
		writeError(w, http.StatusForbidden, "apx_cross_site_denied", "cross-site request denied")
		return
	}

	switch r.URL.Path {
	case "/":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, s.page())
		return
	case "/health":
		s.handleHealth(w, r)
		return
	case "/api/status":
		s.handleStatus(w, r)
		return
	case "/api/scan":
		s.handleScan(w, r)
		return
	case "/api/reload":
		s.handleReload(w, r)
		return
	}

	if strings.HasPrefix(r.URL.Path, "/v1/") && !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, "apx_unauthorized", "缺少或错误的本地令牌；运行 `apx token` 查看当前值")
		return
	}

	switch r.URL.Path {
	case "/v1/models", "/models":
		s.handleModels(w, r)
	case "/v1/chat/completions", "/chat/completions":
		s.acquire(w, r, s.handleChat)
	case "/v1/responses", "/responses":
		s.acquire(w, r, s.handleResponses)
	default:
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			writeError(w, http.StatusNotImplemented, "apx_unsupported_endpoint",
				"未实现该端点；当前支持 /v1/models、/v1/chat/completions、/v1/responses")
			return
		}
		writeError(w, http.StatusNotFound, "apx_not_found", "未找到该路径")
	}
}

func (s *Server) authorized(r *http.Request) bool {
	given := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if given == "" {
		given = strings.TrimSpace(r.Header.Get("X-API-Key"))
	}
	return given != "" && given == s.cfg.Token
}

func (s *Server) acquire(w http.ResponseWriter, r *http.Request, fn func(http.ResponseWriter, *http.Request)) {
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
		fn(w, r)
	default:
		timeout := time.Duration(s.cfg.Limits.QueueTimeoutMS) * time.Millisecond
		t := time.NewTimer(timeout)
		defer t.Stop()
		select {
		case s.sem <- struct{}{}:
			defer func() { <-s.sem }()
			fn(w, r)
		case <-t.C:
			writeError(w, http.StatusServiceUnavailable, "apx_queue_timeout", "并发已满，排队超时")
		case <-r.Context().Done():
		}
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	reg := s.rt.Registry()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"providers": len(reg.Providers),
		"models":    len(reg.ModelIDs()),
		"uptime":    time.Since(s.started).Round(time.Second).String(),
		"endpoint":  "http://" + s.cfg.Listen + "/v1",
	})
}

func (s *Server) handleModels(w http.ResponseWriter, _ *http.Request) {
	reg := s.rt.Registry()
	now := time.Now().Unix()
	seen := map[string]bool{}
	var data []map[string]any
	add := func(id, owner string, m config.Model) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		item := map[string]any{"id": id, "object": "model", "created": now, "owned_by": owner}
		if m.ContextWindow > 0 {
			item["context_window"] = m.ContextWindow
			item["max_input_tokens"] = m.ContextWindow
		}
		if m.MaxOutputTokens > 0 {
			item["max_output_tokens"] = m.MaxOutputTokens
		}
		data = append(data, item)
	}
	// Qualified names first (magpie style), then unique bare names so simple
	// clients that store just "qwen2.5:0.5b" keep working.
	for _, p := range reg.Providers {
		if p.Disabled {
			continue
		}
		for _, m := range p.Models {
			add(p.ID+"/"+m.ID, p.ID, m)
		}
	}
	for _, g := range reg.Groups {
		for _, pid := range g.Providers {
			p, ok := reg.Provider(pid)
			if !ok || p.Disabled {
				continue
			}
			for _, m := range p.Models {
				add(g.ID+"/"+m.ID, g.ID, m)
			}
		}
	}
	unique := map[string][]config.Model{}
	for _, p := range reg.Providers {
		if p.Disabled {
			continue
		}
		for _, m := range p.Models {
			unique[m.ID] = append(unique[m.ID], m)
		}
	}
	for id, list := range unique {
		if len(list) == 1 {
			add(id, "apx2", list[0])
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": data})
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	reg := s.rt.Registry()
	health := s.rt.HealthSnapshot()

	type providerView struct {
		ID       string         `json:"id"`
		Name     string         `json:"name"`
		Protocol string         `json:"protocol"`
		BaseURL  string         `json:"baseUrl"`
		Discover bool           `json:"discover"`
		Disabled bool           `json:"disabled"`
		Notes    string         `json:"notes,omitempty"`
		Models   []string       `json:"models"`
		Health   *router.Health `json:"health,omitempty"`
	}
	providers := make([]providerView, 0, len(reg.Providers))
	for _, p := range reg.Providers {
		ids := make([]string, 0, len(p.Models))
		for _, m := range p.Models {
			ids = append(ids, m.ID)
		}
		view := providerView{
			ID: p.ID, Name: p.Name, Protocol: p.Protocol, BaseURL: p.BaseURL,
			Discover: p.Discover, Disabled: p.Disabled, Notes: p.Notes, Models: ids,
		}
		if h, ok := health[p.ID]; ok {
			view.Health = &h
		}
		providers = append(providers, view)
	}

	s.mu.Lock()
	recent := append([]RequestRecord(nil), s.recent...)
	reqs, errs, tokens := s.reqs, s.errs, s.tokens
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"running":  true,
		"version":  Version,
		"listen":   s.cfg.Listen,
		"baseURL":  "http://" + s.cfg.Listen + "/v1",
		"token":    s.cfg.Token,
		"uptime":   time.Since(s.started).Round(time.Second).String(),
		"providers": providers,
		"groups":    reg.Groups,
		"models":    reg.ModelIDs(),
		"requests":  reqs,
		"errors":    errs,
		"tokens":    tokens,
		"recent":    recent,
	})
}

func (s *Server) handleScan(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, harness.Scan(ctx))
}

func (s *Server) handleReload(w http.ResponseWriter, r *http.Request) {
	cfg, err := config.Load()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "apx_config_error", err.Error())
		return
	}
	reg, err := config.LoadRegistry()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "apx_registry_error", err.Error())
		return
	}
	s.rt.Reload(reg, cfg.Aliases)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	notes := s.RefreshModels(ctx)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "providers": len(s.rt.Registry().Providers), "discovery": notes,
	})
}

// RefreshModels fills in models for providers declared with discover=true. It is
// best-effort and never removes a statically configured model.
func (s *Server) RefreshModels(ctx context.Context) []string {
	reg := s.rt.Registry()
	var notes []string
	for i := range reg.Providers {
		p := &reg.Providers[i]
		if !p.Discover || p.Disabled {
			continue
		}
		models, err := s.up.ListModels(ctx, *p, authFor(*p), 8*time.Second)
		if err != nil {
			notes = append(notes, fmt.Sprintf("%s: %v", p.ID, err))
			continue
		}
		if len(models) > 0 {
			p.Models = mergeModels(p.Models, models)
			notes = append(notes, fmt.Sprintf("%s: %d 个模型", p.ID, len(p.Models)))
		}
	}
	s.rt.Reload(reg, s.cfg.Aliases)
	return notes
}

func mergeModels(old, discovered []config.Model) []config.Model {
	seen := map[string]bool{}
	var out []config.Model
	for _, m := range old {
		seen[m.ID] = true
		out = append(out, m)
	}
	for _, m := range discovered {
		if !seen[m.ID] {
			out = append(out, m)
		}
	}
	return out
}

func (s *Server) record(rec RequestRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reqs++
	if rec.Status >= 400 {
		s.errs++
	}
	s.tokens += int64(rec.Tokens)
	s.lastAt = time.Now()
	s.recent = append(s.recent, rec)
	if len(s.recent) > 60 {
		s.recent = s.recent[len(s.recent)-60:]
	}
}

func decodeBody(r *http.Request) (map[string]any, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	return body, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{
		"message": message, "type": "apx_error", "code": code,
	}})
}

func asMessages(v any) []map[string]any {
	raw, _ := v.([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func asTools(v any) []map[string]any {
	raw, _ := v.([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
