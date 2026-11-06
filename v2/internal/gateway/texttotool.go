package gateway

import (
	"strings"

	"apx2/internal/config"
	"apx2/internal/protocol"
)

// maybeTextToTool lets a model that never emits tool calls still drive a tool
// based UI (Coopanion's pet only reacts to pet_say). It only fires when:
//   - the tool was actually offered,
//   - the previous turn is not already that tool's result,
//   - the model returned plain text and no tool call.
func (s *Server) maybeTextToTool(messages []map[string]any, tools []map[string]any, chat map[string]any) (map[string]any, []string) {
	cfg := s.cfg.Limits.TextToTool
	if cfg == nil || cfg.Tool == "" || chat == nil {
		return chat, nil
	}
	if !toolOffered(tools, cfg.Tool) {
		return chat, nil
	}
	if lastToolResult(messages, cfg.Tool) {
		return chat, nil
	}
	choices := protocol.Slice(chat["choices"])
	if len(choices) == 0 {
		return chat, nil
	}
	choice := protocol.Map(choices[0])
	msg := protocol.Map(choice["message"])
	if len(protocol.Slice(msg["tool_calls"])) > 0 {
		return chat, nil
	}
	text := strings.TrimSpace(protocol.Text(msg["content"]))
	if text == "" {
		return chat, nil
	}
	limit := cfg.MaxChars
	if limit <= 0 {
		limit = 400
	}
	if len(text) > limit {
		text = text[:limit] + "…"
	}
	arg := map[string]any{cfg.Argument: text}
	msg["content"] = nil
	msg["tool_calls"] = []any{map[string]any{
		"id":   protocol.NewID("call_"),
		"type": "function",
		"function": map[string]any{
			"name":      cfg.Tool,
			"arguments": protocol.JSONString(arg),
		},
	}}
	choice["message"] = msg
	choice["finish_reason"] = "tool_calls"
	choices[0] = choice
	chat["choices"] = choices
	return chat, []string{"text_to_tool:" + cfg.Tool}
}

func toolOffered(tools []map[string]any, name string) bool {
	for _, t := range tools {
		if toolName(t) == name {
			return true
		}
	}
	return false
}

func toolName(t map[string]any) string {
	if fn := protocol.Map(t["function"]); len(fn) > 0 {
		if n := protocol.Str(fn["name"]); n != "" {
			return n
		}
	}
	return protocol.Str(t["name"])
}

func lastToolResult(messages []map[string]any, tool string) bool {
	if len(messages) == 0 {
		return false
	}
	last := messages[len(messages)-1]
	if protocol.Str(last["role"]) != "tool" {
		return false
	}
	id := protocol.Str(last["tool_call_id"])
	for i := len(messages) - 2; i >= 0; i-- {
		if protocol.Str(messages[i]["role"]) != "assistant" {
			continue
		}
		for _, raw := range protocol.Slice(messages[i]["tool_calls"]) {
			call := protocol.Map(raw)
			if protocol.Str(call["id"]) != id {
				continue
			}
			return protocol.Str(protocol.Map(call["function"])["name"]) == tool
		}
	}
	return false
}

// textToToolActive reports whether the current request needs a buffered
// upstream call so the compatibility layer can see the whole answer.
func (s *Server) textToToolActive(messages []map[string]any, tools []map[string]any) bool {
	cfg := s.cfg.Limits.TextToTool
	if cfg == nil || cfg.Tool == "" {
		return false
	}
	return toolOffered(tools, cfg.Tool) && !lastToolResult(messages, cfg.Tool)
}

func chatTools(tools []map[string]any) []map[string]any { return tools }

func hasModel(list []config.Model, id string) bool {
	for _, m := range list {
		if m.ID == id {
			return true
		}
	}
	return false
}
