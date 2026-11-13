package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"apx2/internal/router"
)

func TestStatusRecordsClientAndAccount(t *testing.T) {
	t.Setenv("APX_TEST_KEY", "up-secret")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"choices": []any{map[string]any{
				"message":       map[string]any{"role": "assistant", "content": "hi"},
				"finish_reason": "stop",
			}},
			"usage": map[string]any{"total_tokens": 2},
		})
	}))
	defer up.Close()

	cfg := testConfig()
	cfg.Limits.TextToTool = nil
	srv := New(cfg, router.New(testRegistry(provider("local", up.URL)), nil))

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"local/up-model","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer test-key")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Client-Name", "Coopanion")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("chat = %d %s", rec.Code, rec.Body.String())
	}

	statusReq := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	statusRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(statusRec, statusReq)
	var st struct {
		Recent    []RequestRecord `json:"recent"`
		Providers []struct {
			Account struct {
				Label string `json:"label"`
			} `json:"account"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(statusRec.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if len(st.Recent) != 1 {
		t.Fatalf("recent = %+v", st.Recent)
	}
	if st.Recent[0].Client != "Coopanion" {
		t.Fatalf("client = %q", st.Recent[0].Client)
	}
	if st.Recent[0].Account != "key ····cret" {
		t.Fatalf("account = %q", st.Recent[0].Account)
	}
	if len(st.Providers) != 1 || st.Providers[0].Account.Label != "key ····cret" {
		t.Fatalf("provider account = %+v", st.Providers)
	}
}
