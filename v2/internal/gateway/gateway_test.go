package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"apx2/internal/config"
	"apx2/internal/router"
)

func testConfig() config.Config {
	cfg := config.Default()
	cfg.Token = "test-key"
	cfg.Listen = "127.0.0.1:0"
	cfg.Limits.MaxInputChars = 2000
	cfg.Limits.MaxTools = 8
	return cfg
}

func testRegistry(providers ...config.Provider) config.Registry {
	return config.Registry{Providers: providers}
}

func provider(id, base string) config.Provider {
	return config.Provider{
		ID: id, Name: id, Protocol: config.ProtocolOpenAIChat, BaseURL: base,
		Auth:    config.AuthConfig{Type: "bearer", Env: "APX_TEST_KEY"},
		Paths:   map[string]string{"chat": "/chat/completions", "models": "/models"},
		Models:  []config.Model{{ID: "up-model"}},
		Discover: false,
	}
}

func do(t *testing.T, srv *Server, path string, body any, token string) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(b)))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	return rec
}

func TestChatPassThroughAndTextToTool(t *testing.T) {
	t.Setenv("APX_TEST_KEY", "up-secret")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer up-secret" {
			t.Errorf("upstream auth = %q", got)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "up-model" {
			t.Errorf("upstream model = %v", body["model"])
		}
		writeJSON(w, 200, map[string]any{
			"id": "chatcmpl-1", "object": "chat.completion", "created": 1, "model": "up-model",
			"choices": []any{map[string]any{
				"index": 0, "finish_reason": "stop",
				"message": map[string]any{"role": "assistant", "content": "你好呀"},
			}},
			"usage": map[string]any{"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3},
		})
	}))
	defer up.Close()

	cfg := testConfig()
	srv := New(cfg, router.New(testRegistry(provider("local", up.URL)), nil))
	rec := do(t, srv, "/v1/chat/completions", map[string]any{
		"model":    "local/up-model",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{
			"name": "pet_say", "parameters": map[string]any{"type": "object"},
		}}},
	}, "test-key")

	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var doc map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &doc)
	msg := doc["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	calls, _ := msg["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("expected pet_say call, got %s", rec.Body.String())
	}
	fn := calls[0].(map[string]any)["function"].(map[string]any)
	if fn["name"] != "pet_say" || !strings.Contains(fn["arguments"].(string), "你好呀") {
		t.Fatalf("fn = %v", fn)
	}
	if doc["model"] != "local/up-model" {
		t.Fatalf("downstream model = %v", doc["model"])
	}
	apx := doc["apx"].(map[string]any)
	if apx["provider"] != "local" {
		t.Fatalf("apx = %v", apx)
	}
}

func TestUnauthorized(t *testing.T) {
	cfg := testConfig()
	srv := New(cfg, router.New(testRegistry(), nil))
	rec := do(t, srv, "/v1/chat/completions", map[string]any{
		"model": "x", "messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, "")
	if rec.Code != 401 {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestFailoverToSecondProvider(t *testing.T) {
	t.Setenv("APX_TEST_KEY", "k")
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, 500, "boom", "upstream exploded")
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"choices": []any{map[string]any{
				"message": map[string]any{"role": "assistant", "content": "from-good"},
				"finish_reason": "stop",
			}},
			"usage": map[string]any{"total_tokens": 4},
		})
	}))
	defer good.Close()

	cfg := testConfig()
	cfg.Limits.TextToTool = nil
	badP := provider("bad", bad.URL)
	goodP := provider("good", good.URL)
	reg := config.Registry{
		Providers: []config.Provider{badP, goodP},
		Groups:    []config.Group{{ID: "auto", Strategy: "order", Providers: []string{"bad", "good"}}},
	}
	srv := New(cfg, router.New(reg, nil))
	rec := do(t, srv, "/v1/chat/completions", map[string]any{
		"model":    "auto/up-model",
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var doc map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &doc)
	if doc["apx"].(map[string]any)["provider"] != "good" {
		t.Fatalf("expected failover to good, got %v", doc["apx"])
	}
}

func TestResponsesFromChatUpstream(t *testing.T) {
	t.Setenv("APX_TEST_KEY", "k")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] == true {
			t.Error("text_to_tool requests must be buffered (stream=false)")
		}
		msgs, _ := body["messages"].([]any)
		if len(msgs) == 0 {
			t.Fatal("no messages converted from Responses input")
		}
		first := msgs[0].(map[string]any)
		if first["role"] != "user" {
			t.Errorf("first role = %v", first["role"])
		}
		writeJSON(w, 200, map[string]any{
			"choices": []any{map[string]any{
				"message": map[string]any{"role": "assistant", "content": "打个招呼"},
				"finish_reason": "stop",
			}},
			"usage": map[string]any{"prompt_tokens": 2, "completion_tokens": 4, "total_tokens": 6},
		})
	}))
	defer up.Close()

	cfg := testConfig()
	srv := New(cfg, router.New(testRegistry(provider("local", up.URL)), nil))
	rec := do(t, srv, "/v1/responses", map[string]any{
		"model": "local/up-model",
		"input": []any{map[string]any{"type": "message", "role": "user", "content": "叫我一声"}},
		"tools": []any{map[string]any{
			"type": "function", "name": "pet_say",
			"parameters": map[string]any{"type": "object", "properties": map[string]any{"script": map[string]any{"type": "string"}}},
		}},
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var doc map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &doc)
	output := doc["output"].([]any)
	found := false
	for _, raw := range output {
		item := raw.(map[string]any)
		if item["type"] == "function_call" && item["name"] == "pet_say" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no pet_say function_call: %s", rec.Body.String())
	}
}

func TestStreamChatModelRewrite(t *testing.T) {
	t.Setenv("APX_TEST_KEY", "k")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"model\":\"up-model\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer up.Close()

	cfg := testConfig()
	cfg.Limits.TextToTool = nil
	srv := New(cfg, router.New(testRegistry(provider("local", up.URL)), nil))
	rec := do(t, srv, "/v1/chat/completions", map[string]any{
		"model":    "local/up-model",
		"stream":   true,
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"model":"local/up-model"`) {
		t.Fatalf("model not rewritten: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "[DONE]") {
		t.Fatalf("no DONE: %s", rec.Body.String())
	}
}

func TestStreamResponsesFromChatUpstream(t *testing.T) {
	t.Setenv("APX_TEST_KEY", "k")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"he\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"llo\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer up.Close()

	cfg := testConfig()
	cfg.Limits.TextToTool = nil
	srv := New(cfg, router.New(testRegistry(provider("local", up.URL)), nil))
	rec := do(t, srv, "/v1/responses", map[string]any{
		"model":  "local/up-model",
		"stream": true,
		"input":  "hi",
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{"response.created", "response.output_text.delta", "response.completed"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %s: %s", want, body)
		}
	}
}

func TestModelsEndpoint(t *testing.T) {
	cfg := testConfig()
	srv := New(cfg, router.New(testRegistry(provider("local", "http://x")), nil))
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer test-key")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "local/up-model") || !strings.Contains(rec.Body.String(), `"id":"up-model"`) {
		t.Fatalf("models = %s", rec.Body.String())
	}
}

func TestQueueTimeout(t *testing.T) {
	cfg := testConfig()
	cfg.Limits.MaxConcurrent = 1
	cfg.Limits.QueueTimeoutMS = 20
	reg := testRegistry(provider("local", "http://127.0.0.1:1"))
	srv := New(cfg, router.New(reg, nil))
	srv.sem <- struct{}{} // occupy the only slot
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- do(t, srv, "/v1/chat/completions", map[string]any{
			"model": "local/up-model", "messages": []any{map[string]any{"role": "user", "content": "hi"}},
		}, "test-key")
	}()
	select {
	case rec := <-done:
		if rec.Code != 503 {
			t.Fatalf("status = %d", rec.Code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("queue timeout did not fire")
	}
}
