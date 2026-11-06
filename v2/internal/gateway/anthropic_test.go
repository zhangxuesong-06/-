package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"apx2/internal/config"
	"apx2/internal/protocol"
	"apx2/internal/router"
)

func anthropicProvider(base string) config.Provider {
	return config.Provider{
		ID: "glm", Name: "GLM", Protocol: config.ProtocolAnthropic, BaseURL: base,
		Auth:   config.AuthConfig{Type: "bearer", Env: "APX_TEST_KEY"},
		Paths:  map[string]string{"messages": "/messages", "models": "/models"},
		Models: []config.Model{{ID: "glm-5.3"}},
	}
}

func TestAnthropicUpstreamToChat(t *testing.T) {
	t.Setenv("APX_TEST_KEY", "k")
	var got map[string]any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		writeJSON(w, 200, map[string]any{
			"id": "msg_1", "type": "message", "role": "assistant",
			"content": []any{
				map[string]any{"type": "text", "text": "hello"},
				map[string]any{"type": "tool_use", "id": "toolu_1", "name": "pet_say", "input": map[string]any{"script": "hi"}},
			},
			"stop_reason": "tool_use",
			"usage":       map[string]any{"input_tokens": 4, "output_tokens": 6},
		})
	}))
	defer up.Close()

	cfg := testConfig()
	cfg.Limits.TextToTool = nil
	srv := New(cfg, router.New(testRegistry(anthropicProvider(up.URL)), nil))
	rec := do(t, srv, "/v1/chat/completions", map[string]any{
		"model":    "glm/glm-5.3",
		"messages": []any{map[string]any{"role": "system", "content": "sys"}, map[string]any{"role": "user", "content": "hi"}},
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{
			"name": "pet_say", "parameters": map[string]any{"type": "object"},
		}}},
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if got["system"] != "sys" {
		t.Fatalf("anthropic system = %v", got["system"])
	}
	if got["max_tokens"] == nil {
		t.Fatalf("max_tokens missing: %v", got)
	}
	tools, _ := got["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["name"] != "pet_say" {
		t.Fatalf("anthropic tools = %v", got["tools"])
	}
	var doc map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &doc)
	msg := doc["choices"].([]any)[0].(map[string]any)["message"].(map[string]any)
	if protocol.Text(msg["content"]) != "hello" {
		t.Fatalf("content = %v", msg["content"])
	}
	if calls := msg["tool_calls"].([]any); len(calls) != 1 {
		t.Fatalf("tool_calls = %v", msg["tool_calls"])
	}
}

func TestAnthropicUpstreamToResponsesBuffered(t *testing.T) {
	t.Setenv("APX_TEST_KEY", "k")
	var got map[string]any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		writeJSON(w, 200, map[string]any{
			"content":     []any{map[string]any{"type": "text", "text": "hi there"}},
			"stop_reason": "end_turn",
			"usage":       map[string]any{"input_tokens": 1, "output_tokens": 2},
		})
	}))
	defer up.Close()

	cfg := testConfig()
	cfg.Limits.TextToTool = nil
	srv := New(cfg, router.New(testRegistry(anthropicProvider(up.URL)), nil))
	rec := do(t, srv, "/v1/responses", map[string]any{
		"model":  "glm/glm-5.3",
		"stream": true,
		"input":  "hi",
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if got["stream"] != false {
		t.Fatalf("anthropic must be buffered for responses downstream, got stream=%v", got["stream"])
	}
	for _, want := range []string{"response.created", "response.output_text.delta", "response.completed"} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Fatalf("missing %s in %s", want, rec.Body.String())
		}
	}
}

func TestAnthropicStreamToChat(t *testing.T) {
	t.Setenv("APX_TEST_KEY", "k")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\"}\n\n"))
		_, _ = w.Write([]byte("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"yo\"}}\n\n"))
		_, _ = w.Write([]byte("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n"))
		_, _ = w.Write([]byte("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"))
	}))
	defer up.Close()

	cfg := testConfig()
	cfg.Limits.TextToTool = nil
	srv := New(cfg, router.New(testRegistry(anthropicProvider(up.URL)), nil))
	rec := do(t, srv, "/v1/chat/completions", map[string]any{
		"model": "glm/glm-5.3", "stream": true,
		"messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, "test-key")
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"content":"yo"`) || !strings.Contains(rec.Body.String(), "[DONE]") {
		t.Fatalf("stream = %s", rec.Body.String())
	}
}

func TestUpstreamErrorIsHonest(t *testing.T) {
	t.Setenv("APX_TEST_KEY", "k")
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 400, map[string]any{"error": map[string]any{
			"message": "model does not exist", "type": "invalid_request_error",
		}})
	}))
	defer up.Close()

	cfg := testConfig()
	srv := New(cfg, router.New(testRegistry(provider("local", up.URL)), nil))
	rec := do(t, srv, "/v1/chat/completions", map[string]any{
		"model": "local/up-model", "messages": []any{map[string]any{"role": "user", "content": "hi"}},
	}, "test-key")
	if rec.Code != 400 {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "model does not exist") {
		t.Fatalf("error = %s", rec.Body.String())
	}
}
