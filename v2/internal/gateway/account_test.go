package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"apx2/internal/auth"
	"apx2/internal/config"
	"apx2/internal/router"
)

func TestAccountPoolRotatesAndRecords(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("APX2_CREDENTIALS", filepath.Join(dir, "credentials.json"))
	if err := auth.SetSecret("pool#a1", "key", "sk-AAAA"); err != nil {
		t.Fatal(err)
	}
	if err := auth.SetSecret("pool#a2", "key", "sk-BBBB"); err != nil {
		t.Fatal(err)
	}

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"choices": []any{map[string]any{
				"message":       map[string]any{"role": "assistant", "content": r.Header.Get("Authorization")},
				"finish_reason": "stop",
			}},
			"usage": map[string]any{"total_tokens": 1},
		})
	}))
	defer up.Close()

	p := config.Provider{
		ID: "pool", Name: "Pool", Protocol: config.ProtocolOpenAIChat, BaseURL: up.URL,
		Auth:   config.AuthConfig{Type: "bearer"},
		Paths:  map[string]string{"chat": "/chat/completions", "models": "/models"},
		Models: []config.Model{{ID: "up-model"}},
		Accounts: []config.Account{
			{ID: "a1"}, {ID: "a2"},
		},
	}
	reg := config.Registry{
		Providers: []config.Provider{p},
		Groups:    []config.Group{{ID: "g", Strategy: "rotate", Providers: []string{"pool"}}},
	}
	cfg := testConfig()
	cfg.Limits.TextToTool = nil
	srv := New(cfg, router.New(reg, nil))

	var contents, accounts []string
	for i := 0; i < 4; i++ {
		rec := do(t, srv, "/v1/chat/completions", map[string]any{
			"model":    "g/up-model",
			"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}, "test-key")
		if rec.Code != 200 {
			t.Fatalf("req %d = %d %s", i, rec.Code, rec.Body.String())
		}
		var doc map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &doc)
		contents = append(contents, doc["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)["content"].(string))
		accounts = append(accounts, rec.Header().Get("X-Apx-Account-Id"))
	}
	want := []string{"Bearer sk-AAAA", "Bearer sk-BBBB", "Bearer sk-AAAA", "Bearer sk-BBBB"}
	for i := range want {
		if contents[i] != want[i] {
			t.Fatalf("contents = %v", contents)
		}
	}
	if accounts[0] != "a1" || accounts[1] != "a2" {
		t.Fatalf("account ids = %v", accounts)
	}

	status := httptest.NewRecorder()
	srv.Handler().ServeHTTP(status, httptest.NewRequest(http.MethodGet, "/api/status", nil))
	var st struct {
		Recent []RequestRecord `json:"recent"`
	}
	_ = json.Unmarshal(status.Body.Bytes(), &st)
	if len(st.Recent) != 4 {
		t.Fatalf("recent = %+v", st.Recent)
	}
	if st.Recent[0].AccountID != "a1" || !strings.Contains(st.Recent[0].Account, "AAAA") {
		t.Fatalf("account record = %+v", st.Recent[0])
	}
}
