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

func codexProvider(base, authFile string) config.Provider {
	return config.Provider{
		ID: "codex", Name: "Codex", Protocol: config.ProtocolOpenAIResponses,
		BaseURL: base,
		Auth:    config.AuthConfig{Type: "codex-oauth", File: authFile},
		Paths:   map[string]string{"responses": "/responses", "models": "/models"},
		Models:  []config.Model{{ID: "up-model"}},
	}
}

func writeCodexAuth(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")
	raw := `{"tokens":{"access_token":"tok-123","account_id":"acc-1"}}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func codexSSE() string {
	return strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress","output":[]}}`,
		``,
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","delta":"APX-CODEX-OK"}`,
		``,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"up-model","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"APX-CODEX-OK","annotations":[]}]}],"usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}}`,
		``,
	}, "\n")
}

func TestCodexBufferedForResponsesDownstream(t *testing.T) {
	authFile := writeCodexAuth(t)
	var seen map[string]any
	var headers http.Header
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers = r.Header.Clone()
		_ = json.NewDecoder(r.Body).Decode(&seen)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(codexSSE()))
	}))
	defer up.Close()

	cfg := testConfig()
	cfg.Limits.TextToTool = nil
	srv := New(cfg, router.New(testRegistry(codexProvider(up.URL, authFile)), nil))
	rec := do(t, srv, "/v1/responses", map[string]any{
		"model": "codex/up-model",
		"input": "hi",
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if seen["stream"] != true {
		t.Fatalf("codex upstream must stream, got %v", seen["stream"])
	}
	if headers.Get("version") == "" || headers.Get("session-id") == "" {
		t.Fatalf("missing codex client headers: %v", headers)
	}
	if headers.Get("originator") != "codex_cli_rs" {
		t.Fatalf("originator = %q", headers.Get("originator"))
	}
	if headers.Get("x-codex-routing-hint") != "model=up-model" {
		t.Fatalf("routing hint = %q", headers.Get("x-codex-routing-hint"))
	}
	var doc map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &doc)
	if doc["output_text"] != "APX-CODEX-OK" {
		t.Fatalf("output_text = %v", doc["output_text"])
	}
	if len(doc["output"].([]any)) == 0 {
		t.Fatalf("output = %v", doc["output"])
	}
}

func TestCodexToChatDownstream(t *testing.T) {
	authFile := writeCodexAuth(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(codexSSE()))
	}))
	defer up.Close()

	cfg := testConfig()
	cfg.Limits.TextToTool = nil
	srv := New(cfg, router.New(testRegistry(codexProvider(up.URL, authFile)), nil))
	rec := do(t, srv, "/v1/chat/completions", map[string]any{
		"model": "codex/up-model", "messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var doc map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &doc)
	msg := doc["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if msg["content"] != "APX-CODEX-OK" {
		t.Fatalf("content = %v", msg["content"])
	}
}

func TestCodexStreamPassthrough(t *testing.T) {
	authFile := writeCodexAuth(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(codexSSE()))
	}))
	defer up.Close()

	cfg := testConfig()
	cfg.Limits.TextToTool = nil
	srv := New(cfg, router.New(testRegistry(codexProvider(up.URL, authFile)), nil))
	rec := do(t, srv, "/v1/responses", map[string]any{
		"model": "codex/up-model", "stream": true, "input": "hi",
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "response.output_text.delta") {
		t.Fatalf("stream passthrough lost events: %s", rec.Body.String())
	}
}
