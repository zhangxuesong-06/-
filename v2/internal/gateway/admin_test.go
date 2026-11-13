package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"apx2/internal/config"
	"apx2/internal/router"
)

func adminServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("APX2_REGISTRY", filepath.Join(dir, "providers.json"))
	t.Setenv("APX2_CREDENTIALS", filepath.Join(dir, "credentials.json"))
	t.Setenv("APX2_CONFIG", filepath.Join(dir, "config.json"))
	return New(testConfig(), router.New(config.Registry{}, nil))
}

func adminDo(t *testing.T, srv *Server, method, path string, body any, token string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == nil {
		reader = strings.NewReader("")
	} else {
		b, _ := json.Marshal(body)
		reader = strings.NewReader(string(b))
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestAdminRequiresToken(t *testing.T) {
	srv := adminServer(t)
	rec := adminDo(t, srv, http.MethodPost, "/api/providers", map[string]any{"id": "x", "baseUrl": "http://x"}, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestAdminCreateProviderAndModels(t *testing.T) {
	srv := adminServer(t)
	rec := adminDo(t, srv, http.MethodPost, "/api/providers", map[string]any{
		"id": "relay", "name": "Relay", "protocol": "openai-chat",
		"baseUrl": "https://relay.example/v1", "authType": "bearer", "apiKey": "sk-secret",
		"models": []string{"m1", "m2"},
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}

	reg, err := config.LoadRegistry()
	if err != nil {
		t.Fatal(err)
	}
	p, ok := reg.Provider("relay")
	if !ok {
		t.Fatal("provider not persisted")
	}
	if p.Auth.Type != "bearer" || len(p.Models) != 2 {
		t.Fatalf("provider = %+v", p)
	}

	raw, err := os.ReadFile(os.Getenv("APX2_CREDENTIALS"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "relay.key") || !strings.Contains(string(raw), "sk-secret") {
		t.Fatalf("credential not stored: %s", raw)
	}
	regRaw, _ := os.ReadFile(os.Getenv("APX2_REGISTRY"))
	if strings.Contains(string(regRaw), "sk-secret") {
		t.Fatal("api key leaked into providers.json")
	}

	models := adminDo(t, srv, http.MethodGet, "/v1/models", nil, "test-key")
	if !strings.Contains(models.Body.String(), "relay/m1") || !strings.Contains(models.Body.String(), "relay/m2") {
		t.Fatalf("models = %s", models.Body.String())
	}

	// Disable the whole provider.
	rec = adminDo(t, srv, http.MethodPatch, "/api/providers/relay", map[string]any{"disabled": true}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("disable = %d %s", rec.Code, rec.Body.String())
	}
	models = adminDo(t, srv, http.MethodGet, "/v1/models", nil, "test-key")
	if strings.Contains(models.Body.String(), "relay/m1") {
		t.Fatalf("disabled provider still exposed: %s", models.Body.String())
	}

	// Re-enable, then keep only m1.
	adminDo(t, srv, http.MethodPatch, "/api/providers/relay", map[string]any{"disabled": false}, "test-key")
	rec = adminDo(t, srv, http.MethodPatch, "/api/providers/relay", map[string]any{"enabledModels": []string{"m1"}}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("models patch = %d %s", rec.Code, rec.Body.String())
	}
	models = adminDo(t, srv, http.MethodGet, "/v1/models", nil, "test-key")
	if !strings.Contains(models.Body.String(), "relay/m1") || strings.Contains(models.Body.String(), "relay/m2") {
		t.Fatalf("model selection not applied: %s", models.Body.String())
	}
}

func TestAdminGroupLifecycle(t *testing.T) {
	srv := adminServer(t)
	adminDo(t, srv, http.MethodPost, "/api/providers", map[string]any{
		"id": "a", "baseUrl": "http://a", "authType": "none", "models": []string{"m"},
	}, "test-key")
	rec := adminDo(t, srv, http.MethodPost, "/api/groups", map[string]any{
		"id": "grp", "name": "Group", "strategy": "rotate", "providers": []string{"a"},
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("group create = %d %s", rec.Code, rec.Body.String())
	}
	reg, _ := config.LoadRegistry()
	g, ok := reg.Group("grp")
	if !ok || g.Strategy != "rotate" || len(g.Providers) != 1 {
		t.Fatalf("group = %+v", g)
	}
	rec = adminDo(t, srv, http.MethodDelete, "/api/groups/grp", nil, "test-key")
	if rec.Code != 200 {
		t.Fatalf("group delete = %d %s", rec.Code, rec.Body.String())
	}
	reg, _ = config.LoadRegistry()
	if _, ok := reg.Group("grp"); ok {
		t.Fatal("group not deleted")
	}
}

func TestAdminAccountPool(t *testing.T) {
	srv := adminServer(t)
	rec := adminDo(t, srv, http.MethodPost, "/api/providers", map[string]any{
		"id": "pool", "protocol": "openai-chat", "baseUrl": "https://pool.example/v1",
		"authType": "bearer", "models": []string{"m"},
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("provider = %d %s", rec.Code, rec.Body.String())
	}
	for _, a := range []map[string]any{
		{"id": "a1", "name": "主号", "apiKey": "sk-AAAA"},
		{"id": "a2", "name": "备用", "apiKey": "sk-BBBB"},
	} {
		rec = adminDo(t, srv, http.MethodPost, "/api/providers/pool/accounts", a, "test-key")
		if rec.Code != 200 {
			t.Fatalf("account = %d %s", rec.Code, rec.Body.String())
		}
	}
	reg, _ := config.LoadRegistry()
	p, _ := reg.Provider("pool")
	if len(p.Accounts) != 2 {
		t.Fatalf("accounts = %+v", p.Accounts)
	}
	raw, _ := os.ReadFile(os.Getenv("APX2_CREDENTIALS"))
	if !strings.Contains(string(raw), "pool#a1.key") || !strings.Contains(string(raw), "pool#a2.key") {
		t.Fatalf("credentials = %s", raw)
	}

	status := adminDo(t, srv, http.MethodGet, "/api/status", nil, "test-key")
	var st struct {
		Providers []struct {
			ID       string `json:"id"`
			Accounts []struct {
				ID     string `json:"id"`
				Label  string `json:"label"`
				KeySet bool   `json:"keySet"`
			} `json:"accounts"`
		} `json:"providers"`
	}
	_ = json.Unmarshal(status.Body.Bytes(), &st)
	found := false
	for _, pv := range st.Providers {
		if pv.ID != "pool" {
			continue
		}
		found = len(pv.Accounts) == 2 && pv.Accounts[0].KeySet && strings.Contains(pv.Accounts[0].Label, "主号")
	}
	if !found {
		t.Fatalf("status accounts = %s", status.Body.String())
	}

	rec = adminDo(t, srv, http.MethodPatch, "/api/providers/pool/accounts/a1", map[string]any{"models": []string{"m"}}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("models = %d %s", rec.Code, rec.Body.String())
	}
	reg, _ = config.LoadRegistry()
	p, _ = reg.Provider("pool")
	if a, _ := p.Account("a1"); len(a.Models) != 1 || a.Models[0] != "m" {
		t.Fatalf("account models = %+v", a.Models)
	}
	rec = adminDo(t, srv, http.MethodPatch, "/api/providers/pool/accounts/a1", map[string]any{"models": []string{}}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("models clear = %d %s", rec.Code, rec.Body.String())
	}
	reg, _ = config.LoadRegistry()
	p, _ = reg.Provider("pool")
	if a, _ := p.Account("a1"); len(a.Models) != 0 {
		t.Fatalf("account models not cleared = %+v", a.Models)
	}

	rec = adminDo(t, srv, http.MethodPatch, "/api/providers/pool/accounts/a1", map[string]any{"disabled": true}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("disable = %d %s", rec.Code, rec.Body.String())
	}
	reg, _ = config.LoadRegistry()
	p, _ = reg.Provider("pool")
	if a, _ := p.Account("a1"); !a.Disabled {
		t.Fatal("account not disabled")
	}

	rec = adminDo(t, srv, http.MethodDelete, "/api/providers/pool/accounts/a2", nil, "test-key")
	if rec.Code != 200 {
		t.Fatalf("delete = %d %s", rec.Code, rec.Body.String())
	}
	reg, _ = config.LoadRegistry()
	p, _ = reg.Provider("pool")
	if len(p.Accounts) != 1 {
		t.Fatalf("accounts after delete = %+v", p.Accounts)
	}
}

func TestAdminDiscoverAndSetKey(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			t.Errorf("path = %s", r.URL.Path)
		}
		writeJSON(w, 200, map[string]any{"data": []any{
			map[string]any{"id": "new-model"},
			map[string]any{"id": "old"},
		}})
	}))
	defer up.Close()

	srv := adminServer(t)
	rec := adminDo(t, srv, http.MethodPost, "/api/providers", map[string]any{
		"id": "disc", "protocol": "openai-chat", "baseUrl": up.URL, "authType": "none",
		"models": []string{"old"}, "discover": true,
		"paths": map[string]string{"models": "/models"},
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("create = %d %s", rec.Code, rec.Body.String())
	}

	rec = adminDo(t, srv, http.MethodPost, "/api/providers/disc/discover", nil, "test-key")
	if rec.Code != 200 {
		t.Fatalf("discover = %d %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Models []config.Model `json:"models"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	ids := map[string]bool{}
	for _, m := range body.Models {
		ids[m.ID] = true
	}
	if !ids["new-model"] || !ids["old"] {
		t.Fatalf("models = %+v", body.Models)
	}

	rec = adminDo(t, srv, http.MethodPost, "/api/providers/disc/key", map[string]any{"apiKey": "k-12345678"}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("key = %d %s", rec.Code, rec.Body.String())
	}
	reg, _ := config.LoadRegistry()
	p, _ := reg.Provider("disc")
	if p.Auth.Type != "bearer" {
		t.Fatalf("auth type = %s", p.Auth.Type)
	}
	raw, _ := os.ReadFile(os.Getenv("APX2_CREDENTIALS"))
	if !strings.Contains(string(raw), "k-12345678") {
		t.Fatalf("credentials = %s", raw)
	}
}
