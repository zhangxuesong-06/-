package protocol

import (
	"bufio"
	"encoding/json"
	"strings"
	"testing"
)

func TestChatToAnthropic(t *testing.T) {
	req := map[string]any{
		"model": "glm-5.3",
		"messages": []any{
			map[string]any{"role": "system", "content": "you are terse"},
			map[string]any{"role": "user", "content": "hi"},
			map[string]any{"role": "assistant", "tool_calls": []any{
				map[string]any{"id": "call_1", "type": "function", "function": map[string]any{
					"name": "lookup", "arguments": `{"q":"x"}`,
				}},
			}},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "42"},
		},
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{
			"name": "lookup", "description": "look", "parameters": map[string]any{"type": "object"},
		}}},
	}
	out := ChatToAnthropic(req)
	if out["system"] != "you are terse" {
		t.Fatalf("system = %v", out["system"])
	}
	if out["max_tokens"].(int) != 8192 {
		t.Fatalf("max_tokens = %v", out["max_tokens"])
	}
	msgs := Slice(out["messages"])
	if len(msgs) != 3 {
		t.Fatalf("messages = %d (%v)", len(msgs), msgs)
	}
	assistant := Map(msgs[1])
	blocks := Slice(assistant["content"])
	if len(blocks) != 1 || Str(Map(blocks[0])["type"]) != "tool_use" {
		t.Fatalf("assistant blocks = %v", blocks)
	}
	if got := Map(Map(blocks[0])["input"]); Str(got["q"]) != "x" {
		t.Fatalf("tool input = %v", got)
	}
	toolResult := Map(Map(msgs[2])["content"].([]any)[0])
	if Str(toolResult["type"]) != "tool_result" || Str(toolResult["tool_use_id"]) != "call_1" {
		t.Fatalf("tool result = %v", toolResult)
	}
	tools := Slice(out["tools"])
	if len(tools) != 1 || Str(Map(tools[0])["name"]) != "lookup" {
		t.Fatalf("tools = %v", tools)
	}
}

func TestAnthropicToChat(t *testing.T) {
	resp := map[string]any{
		"id": "msg_1",
		"content": []any{
			map[string]any{"type": "text", "text": "thinking"},
			map[string]any{"type": "tool_use", "id": "toolu_1", "name": "pet_say", "input": map[string]any{"script": "hi"}},
		},
		"stop_reason": "tool_use",
		"usage":       map[string]any{"input_tokens": 3, "output_tokens": 5},
	}
	chat := AnthropicToChat(resp, "glm-5.3")
	choice := Map(Slice(chat["choices"])[0])
	msg := Map(choice["message"])
	if Text(msg["content"]) != "thinking" {
		t.Fatalf("content = %v", msg["content"])
	}
	calls := Slice(msg["tool_calls"])
	if len(calls) != 1 {
		t.Fatalf("tool_calls = %v", calls)
	}
	fn := Map(Map(calls[0])["function"])
	if Str(fn["name"]) != "pet_say" || !strings.Contains(Str(fn["arguments"]), "hi") {
		t.Fatalf("fn = %v", fn)
	}
	if Str(choice["finish_reason"]) != "tool_calls" {
		t.Fatalf("finish = %v", choice["finish_reason"])
	}
	usage := Map(chat["usage"])
	if Int(usage["total_tokens"]) != 8 {
		t.Fatalf("usage = %v", usage)
	}
}

func TestResponsesToChatRequest(t *testing.T) {
	req := map[string]any{
		"model":        "gpt-6.1-sol",
		"instructions": "be brief",
		"input": []any{
			map[string]any{"type": "message", "role": "user", "content": []any{
				map[string]any{"type": "input_text", "text": "hello"},
			}},
			map[string]any{"type": "function_call", "call_id": "call_a", "name": "pet_say", "arguments": `{"script":"x"}`},
			map[string]any{"type": "function_call", "call_id": "call_b", "name": "pet_ask", "arguments": `{}`},
			map[string]any{"type": "function_call_output", "call_id": "call_a", "output": "ok"},
		},
		"tools": []any{map[string]any{
			"type": "function", "name": "pet_say", "parameters": map[string]any{"type": "object"},
		}},
		"max_output_tokens": 123,
	}
	chat := ResponsesToChatRequest(req)
	msgs := Slice(chat["messages"])
	if len(msgs) != 4 {
		t.Fatalf("messages = %d (%v)", len(msgs), msgs)
	}
	if Str(Map(msgs[0])["role"]) != "system" || Text(Map(msgs[0])["content"]) != "be brief" {
		t.Fatalf("system = %v", msgs[0])
	}
	assistant := Map(msgs[2])
	if calls := Slice(assistant["tool_calls"]); len(calls) != 2 {
		t.Fatalf("merged tool_calls = %v", calls)
	}
	tool := Map(msgs[3])
	if Str(tool["role"]) != "tool" || Str(tool["tool_call_id"]) != "call_a" {
		t.Fatalf("tool = %v", tool)
	}
	if Int(chat["max_tokens"]) != 123 {
		t.Fatalf("max_tokens = %v", chat["max_tokens"])
	}
	toolDef := Map(Slice(chat["tools"])[0])
	if Str(Map(toolDef["function"])["name"]) != "pet_say" {
		t.Fatalf("tools = %v", chat["tools"])
	}
}

func TestChatToResponsesResponse(t *testing.T) {
	chat := map[string]any{
		"choices": []any{map[string]any{
			"message": map[string]any{
				"role":    "assistant",
				"content": "done",
				"tool_calls": []any{map[string]any{
					"id": "call_1", "type": "function",
					"function": map[string]any{"name": "pet_say", "arguments": `{"script":"hi"}`},
				}},
			},
			"finish_reason": "tool_calls",
		}},
		"usage": map[string]any{"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5},
	}
	resp := ChatToResponsesResponse(chat, "qwen", "resp_1")
	output := Slice(resp["output"])
	if len(output) != 2 {
		t.Fatalf("output = %v", output)
	}
	if Str(Map(output[0])["type"]) != "message" || Str(Map(output[1])["type"]) != "function_call" {
		t.Fatalf("output types = %v", output)
	}
	if Str(resp["output_text"]) != "done" {
		t.Fatalf("output_text = %v", resp["output_text"])
	}
	if Int(Map(resp["usage"])["total_tokens"]) != 5 {
		t.Fatalf("usage = %v", resp["usage"])
	}
}

func TestChatToResponsesRequest(t *testing.T) {
	chat := map[string]any{
		"model": "ollama/qwen",
		"messages": []any{
			map[string]any{"role": "system", "content": "sys"},
			map[string]any{"role": "user", "content": "hi"},
			map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{
				map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "f", "arguments": "{}"}},
			}},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "ok"},
		},
		"max_tokens": 50,
	}
	out := ChatToResponsesRequest(chat)
	input := Slice(out["input"])
	if len(input) != 4 {
		t.Fatalf("input = %v", input)
	}
	if Str(Map(input[1])["role"]) != "user" {
		t.Fatalf("input[1] = %v", input[1])
	}
	if Str(Map(input[2])["type"]) != "function_call" {
		t.Fatalf("input[2] = %v", input[2])
	}
	if Str(Map(input[3])["type"]) != "function_call_output" {
		t.Fatalf("input[3] = %v", input[3])
	}
	if Int(out["max_output_tokens"]) != 50 {
		t.Fatalf("max_output_tokens = %v", out["max_output_tokens"])
	}
}

func TestStreamChatToResponses(t *testing.T) {
	upstream := strings.Join([]string{
		`data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"he"}}]}`,
		``,
		`data: {"choices":[{"index":0,"delta":{"content":"llo"}}]}`,
		``,
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"pet_say","arguments":"{\"script\":"}}]}}]}`,
		``,
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"hi\"}"}}]},"finish_reason":"tool_calls"}]}`,
		``,
		`data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}`,
		``,
		`data: [DONE]`,
		``,
	}, "\n")

	var out strings.Builder
	if err := StreamChatToResponses(strings.NewReader(upstream), &out, nil, "qwen", "resp_x"); err != nil {
		t.Fatal(err)
	}
	events := parseSSE(t, out.String())
	for _, want := range []string{"response.created", "response.output_text.delta", "response.function_call_arguments.delta", "response.completed"} {
		if !events[want] {
			t.Fatalf("missing %s in %v", want, keys(events))
		}
	}
	if !strings.Contains(out.String(), `"arguments":"{\"script\":\"hi\"}"`) {
		t.Fatalf("tool args not accumulated: %s", out.String())
	}
}

func TestStreamAnthropicToChat(t *testing.T) {
	upstream := strings.Join([]string{
		`event: message_start`,
		`data: {"type":"message_start","message":{"id":"msg_1"}}`,
		``,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
		``,
		`event: message_delta`,
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
		``,
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		``,
	}, "\n")
	var out strings.Builder
	if err := StreamAnthropicToChat(strings.NewReader(upstream), &out, nil, "glm"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"content":"hi"`) {
		t.Fatalf("content missing: %s", out.String())
	}
	if !strings.Contains(out.String(), "[DONE]") {
		t.Fatalf("DONE missing: %s", out.String())
	}
}

func parseSSE(t *testing.T, raw string) map[string]bool {
	t.Helper()
	seen := map[string]bool{}
	r := bufio.NewReader(strings.NewReader(raw))
	for {
		event, data, err := ReadSSE(r)
		if err != nil {
			break
		}
		if event != "" {
			seen[event] = true
		}
		if data == "[DONE]" {
			seen["[DONE]"] = true
		}
	}
	return seen
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestNewIDUnique(t *testing.T) {
	a, b := NewID("x_"), NewID("x_")
	if a == b {
		t.Fatal("ids collided")
	}
	if !json.Valid([]byte(`{"a":1}`)) {
		t.Fatal("sanity")
	}
}
