package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"apx2/internal/auth"
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

	active int64
	queued int64

	started time.Time

	mu     sync.Mutex
	recent []RequestRecord
	reqs   int
	errs   int
	tokens int64
	lastAt time.Time

	wbMu     sync.Mutex
	wbLogins map[string]*wbLoginState
}

type RequestRecord struct {
	At         string `json:"at"`
	Path       string `json:"path"`
	Client     string `json:"client,omitempty"`
	Model      string `json:"model,omitempty"`
	Provider   string `json:"provider,omitempty"`
	Account    string `json:"account,omitempty"`
	AccountID  string `json:"accountId,omitempty"`
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
		cfg:      cfg,
		rt:       rt,
		up:       upstream.NewClient(time.Duration(cfg.TimeoutSeconds)*time.Second, cfg.Proxy),
		sem:      make(chan struct{}, max(1, cfg.Limits.MaxConcurrent)),
		started:  time.Now(),
		wbLogins: map[string]*wbLoginState{},
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
	case "/assets/workbuddy.png":
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(workbuddyPNG)
		return
	case "/api/status":
		s.handleStatus(w, r)
		return
	case "/api/scan":
		s.handleScan(w, r)
		return
	case "/api/reload":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "apx_method_not_allowed", "uses POST")
			return
		}
		if !s.authorized(r) {
			writeError(w, http.StatusUnauthorized, "apx_unauthorized", "缺少或错误的本地令牌")
			return
		}
		s.handleReload(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/providers") || strings.HasPrefix(r.URL.Path, "/api/groups") {
		if !s.authorized(r) {
			writeError(w, http.StatusUnauthorized, "apx_unauthorized", "缺少或错误的本地令牌")
			return
		}
		s.handleAdmin(w, r)
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
		atomic.AddInt64(&s.active, 1)
		defer func() {
			<-s.sem
			atomic.AddInt64(&s.active, -1)
		}()
		fn(w, r)
	default:
		timeout := time.Duration(s.cfg.Limits.QueueTimeoutMS) * time.Millisecond
		t := time.NewTimer(timeout)
		defer t.Stop()
		atomic.AddInt64(&s.queued, 1)
		defer atomic.AddInt64(&s.queued, -1)
		select {
		case s.sem <- struct{}{}:
			atomic.AddInt64(&s.active, 1)
			defer func() {
				<-s.sem
				atomic.AddInt64(&s.active, -1)
			}()
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
			if m.Disabled {
				continue
			}
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
				if m.Disabled {
					continue
				}
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
			if !m.Disabled {
				unique[m.ID] = append(unique[m.ID], m)
			}
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

	type accountView struct {
		ID       string         `json:"id"`
		Name     string         `json:"name,omitempty"`
		Label    string         `json:"label"`
		Models   []string       `json:"models,omitempty"`
		Disabled bool           `json:"disabled"`
		KeySet   bool           `json:"keySet"`
		Health   *router.Health `json:"health,omitempty"`
	}
	type providerView struct {
		ID       string         `json:"id"`
		Name     string         `json:"name"`
		Protocol string         `json:"protocol"`
		BaseURL  string         `json:"baseUrl"`
		Proxy    string         `json:"proxy,omitempty"`
		TLSMax   string         `json:"tlsMax,omitempty"`
		Discover bool           `json:"discover"`
		Disabled bool           `json:"disabled"`
		Notes    string         `json:"notes,omitempty"`
		AuthType string         `json:"authType,omitempty"`
		KeySet   bool           `json:"keySet"`
		Account  auth.Identity  `json:"account"`
		Accounts []accountView  `json:"accounts,omitempty"`
		Models   []config.Model `json:"models"`
		Health   *router.Health `json:"health,omitempty"`
	}
	providers := make([]providerView, 0, len(reg.Providers))
	for _, p := range reg.Providers {
		keySet := keyAvailable(p)
		if len(p.Accounts) > 0 {
			keySet = false
		}
		view := providerView{
			ID: p.ID, Name: p.Name, Protocol: p.Protocol, BaseURL: p.BaseURL,
			Proxy: p.Proxy, TLSMax: p.TLSMax, Discover: p.Discover, Disabled: p.Disabled,
			Notes: p.Notes, AuthType: p.Auth.Type, KeySet: keySet, Models: p.Models,
			Account: auth.Describe(p),
		}
		for i := range p.Accounts {
			a := p.Accounts[i]
			av := accountView{
				ID: a.ID, Name: a.Name, Disabled: a.Disabled,
				Label:  auth.DescribeAccount(p, &a).Label,
				Models: a.Models,
				KeySet: accountKeyAvailable(p, a),
			}
			if av.KeySet {
				view.KeySet = true
			}
			if h, ok := health[p.ID+"#"+a.ID]; ok {
				av.Health = &h
			}
			view.Accounts = append(view.Accounts, av)
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
		"running":   true,
		"version":   Version,
		"listen":    s.cfg.Listen,
		"baseURL":   "http://" + s.cfg.Listen + "/v1",
		"token":     s.cfg.Token,
		"uptime":    time.Since(s.started).Round(time.Second).String(),
		"providers": providers,
		"groups":    reg.GroupsWithAuto(),
		"models":    reg.ModelIDs(),
		"requests":  reqs,
		"errors":    errs,
		"tokens":    tokens,
		"recent":    recent,
		"concurrency": map[string]any{
			"active": atomic.LoadInt64(&s.active),
			"queued": atomic.LoadInt64(&s.queued),
			"limit":  cap(s.sem),
		},
	})
}

// keyAvailable reports whether the provider's credential can be resolved right
// now. It never returns the secret itself.
func keyAvailable(p config.Provider) bool {
	_, err := authFor(p)(context.Background())
	return err == nil
}

// providerAuth uses the first enabled account when a provider has a pool, and
// the default credential otherwise. Discovery/test only need one usable key.
func providerAuth(p config.Provider) auth.Resolver {
	for i := range p.Accounts {
		if p.Accounts[i].Disabled {
			continue
		}
		a := p.Accounts[i]
		return auth.BuildAccount(p, &a)
	}
	return auth.Build(p)
}

func accountKeyAvailable(p config.Provider, a config.Account) bool {
	acct := a
	_, err := auth.BuildAccount(p, &acct)(context.Background())
	return err == nil
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
		models, err := s.up.ListModels(ctx, *p, providerAuth(*p), 8*time.Second)
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
