// Package protocol translates between the wire formats apx exposes downstream
// (OpenAI Chat Completions, OpenAI Responses) and the formats it speaks upstream
// (OpenAI Chat, OpenAI Responses, Anthropic Messages).
package protocol

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
)

func NewID(prefix string) string {
	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	return prefix + hex.EncodeToString(buf)
}

func Map(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}

func Slice(v any) []any {
	s, _ := v.([]any)
	return s
}

func Str(v any) string {
	s, _ := v.(string)
	return s
}

func Int(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	}
	return 0
}

// Text flattens the several content shapes OpenAI and Anthropic use.
func Text(v any) string {
	switch c := v.(type) {
	case string:
		return c
	case []any:
		var b strings.Builder
		for _, part := range c {
			switch p := part.(type) {
			case string:
				b.WriteString(p)
			case map[string]any:
				for _, key := range []string{"text", "input_text", "output_text", "content"} {
					if s, ok := p[key].(string); ok {
						b.WriteString(s)
						break
					}
				}
			}
		}
		return b.String()
	}
	return ""
}

func JSONString(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// Chat Completions -> Anthropic Messages
// ---------------------------------------------------------------------------

func ChatToAnthropic(req map[string]any) map[string]any {
	out := map[string]any{"model": req["model"]}
	var system []string
	var messages []any

	appendBlocks := func(role string, blocks []any) {
		if len(blocks) == 0 {
			return
		}
		if n := len(messages); n > 0 {
			prev := Map(messages[n-1])
			if Str(prev["role"]) == role {
				prev["content"] = append(Slice(prev["content"]), blocks...)
				return
			}
		}
		messages = append(messages, map[string]any{"role": role, "content": blocks})
	}

	for _, raw := range Slice(req["messages"]) {
		m := Map(raw)
		role := Str(m["role"])
		switch role {
		case "system", "developer":
			if s := Text(m["content"]); s != "" {
				system = append(system, s)
			}
		case "user":
			appendBlocks("user", openAIContentBlocks(m["content"]))
		case "assistant":
			blocks := openAIContentBlocks(m["content"])
			for _, tcRaw := range Slice(m["tool_calls"]) {
				tc := Map(tcRaw)
				fn := Map(tc["function"])
				input := map[string]any{}
				if s := Str(fn["arguments"]); s != "" {
					_ = json.Unmarshal([]byte(s), &input)
				}
				blocks = append(blocks, map[string]any{
					"type":  "tool_use",
					"id":    firstNonEmpty(Str(tc["id"]), NewID("toolu_")),
					"name":  Str(fn["name"]),
					"input": input,
				})
			}
			appendBlocks("assistant", blocks)
		case "tool":
			block := map[string]any{
				"type":        "tool_result",
				"tool_use_id": Str(m["tool_call_id"]),
				"content":     Text(m["content"]),
			}
			appendBlocks("user", []any{block})
		}
	}
	out["messages"] = messages
	if len(system) > 0 {
		out["system"] = strings.Join(system, "\n\n")
	}
	maxTokens := Int(req["max_tokens"])
	if maxTokens <= 0 {
		maxTokens = Int(req["max_completion_tokens"])
	}
	if maxTokens <= 0 {
		maxTokens = 8192
	}
	out["max_tokens"] = maxTokens
	if v, ok := req["temperature"]; ok {
		out["temperature"] = v
	}
	if v, ok := req["top_p"]; ok {
		out["top_p"] = v
	}
	if v, ok := req["stop"]; ok {
		out["stop_sequences"] = v
	}
	if tools := chatToolsToAnthropic(req["tools"]); len(tools) > 0 {
		out["tools"] = tools
		if tc, ok := req["tool_choice"]; ok {
			out["tool_choice"] = chatToolChoiceToAnthropic(tc)
		}
	}
	if b, ok := req["stream"].(bool); ok {
		out["stream"] = b
	}
	return out
}

func openAIContentBlocks(content any) []any {
	switch c := content.(type) {
	case string:
		if c == "" {
			return nil
		}
		return []any{map[string]any{"type": "text", "text": c}}
	case []any:
		var out []any
		for _, raw := range c {
			p := Map(raw)
			switch Str(p["type"]) {
			case "text", "input_text":
				out = append(out, map[string]any{"type": "text", "text": Str(p["text"])})
			case "image_url":
				if u := imageURL(p); u != "" {
					out = append(out, map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": u}})
				}
			}
		}
		return out
	}
	return nil
}

func imageURL(p map[string]any) string {
	switch img := p["image_url"].(type) {
	case string:
		return img
	case map[string]any:
		return Str(img["url"])
	}
	return ""
}

func chatToolsToAnthropic(v any) []any {
	var out []any
	for _, raw := range Slice(v) {
		t := Map(raw)
		fn := Map(t["function"])
		name := Str(fn["name"])
		if name == "" {
			name = Str(t["name"])
		}
		if name == "" {
			continue
		}
		schema := fn["parameters"]
		if schema == nil {
			schema = t["parameters"]
		}
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{
			"name":         name,
			"description":  firstNonEmpty(Str(fn["description"]), Str(t["description"])),
			"input_schema": schema,
		})
	}
	return out
}

func chatToolChoiceToAnthropic(v any) any {
	switch tc := v.(type) {
	case string:
		switch tc {
		case "auto":
			return map[string]any{"type": "auto"}
		case "required":
			return map[string]any{"type": "any"}
		case "none":
			return nil
		}
	case map[string]any:
		if name := Str(Map(tc["function"])["name"]); name != "" {
			return map[string]any{"type": "tool", "name": name}
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Anthropic Messages -> Chat Completions
// ---------------------------------------------------------------------------

func AnthropicToChat(resp map[string]any, model string) map[string]any {
	var text strings.Builder
	var toolCalls []any
	for _, raw := range Slice(resp["content"]) {
		block := Map(raw)
		switch Str(block["type"]) {
		case "text":
			text.WriteString(Str(block["text"]))
		case "tool_use":
			toolCalls = append(toolCalls, map[string]any{
				"id":   Str(block["id"]),
				"type": "function",
				"function": map[string]any{
					"name":      Str(block["name"]),
					"arguments": JSONString(block["input"]),
				},
			})
		}
	}
	message := map[string]any{"role": "assistant", "content": text.String()}
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
		if text.Len() == 0 {
			message["content"] = nil
		}
	}
	finish := "stop"
	switch Str(resp["stop_reason"]) {
	case "tool_use":
		finish = "tool_calls"
	case "max_tokens":
		finish = "length"
	case "stop_sequence":
		finish = "stop"
	}
	usage := Map(resp["usage"])
	return map[string]any{
		"id":      firstNonEmpty(Str(resp["id"]), NewID("chatcmpl_")),
		"object":  "chat.completion",
		"created": nowUnix(),
		"model":   model,
		"choices": []any{map[string]any{
			"index": 0, "message": message, "logprobs": nil, "finish_reason": finish,
		}},
		"usage": map[string]any{
			"prompt_tokens":     Int(usage["input_tokens"]),
			"completion_tokens": Int(usage["output_tokens"]),
			"total_tokens":      Int(usage["input_tokens"]) + Int(usage["output_tokens"]),
		},
	}
}

// ---------------------------------------------------------------------------
// Responses API -> Chat Completions (request) and back (response)
// ---------------------------------------------------------------------------

func ResponsesToChatRequest(req map[string]any) map[string]any {
	out := map[string]any{"model": req["model"]}
	if v, ok := req["stream"]; ok {
		out["stream"] = v
	}
	var messages []any

	if instr := Str(req["instructions"]); instr != "" {
		messages = append(messages, map[string]any{"role": "system", "content": instr})
	}
	switch input := req["input"].(type) {
	case string:
		messages = append(messages, map[string]any{"role": "user", "content": input})
	case []any:
		for _, raw := range input {
			item := Map(raw)
			typ := Str(item["type"])
			switch typ {
			case "function_call":
				call := map[string]any{
					"id":   Str(item["call_id"]),
					"type": "function",
					"function": map[string]any{
						"name":      Str(item["name"]),
						"arguments": Str(item["arguments"]),
					},
				}
				mergeAssistantCall(&messages, call)
			case "function_call_output":
				messages = append(messages, map[string]any{
					"role":         "tool",
					"tool_call_id": Str(item["call_id"]),
					"content":      Text(item["output"]),
				})
			case "reasoning":
				// Reasoning items are protocol bookkeeping; they are not part of
				// a Chat Completions history.
			default:
				role := Str(item["role"])
				if role == "" {
					continue
				}
				if role == "developer" {
					role = "system"
				}
				messages = append(messages, map[string]any{"role": role, "content": responsesContentToChat(item["content"])})
			}
		}
	}
	out["messages"] = messages
	if v, ok := req["max_output_tokens"]; ok {
		out["max_tokens"] = v
	}
	for _, k := range []string{"temperature", "top_p", "parallel_tool_calls", "user"} {
		if v, ok := req[k]; ok {
			out[k] = v
		}
	}
	if tools := responsesToolsToChat(req["tools"]); len(tools) > 0 {
		out["tools"] = tools
		if tc, ok := req["tool_choice"]; ok {
			out["tool_choice"] = tc
		}
	}
	return out
}

// ChatToResponsesRequest is the inverse of ResponsesToChatRequest, used when a
// Chat Completions client is routed to a Responses-only provider (Codex).
func ChatToResponsesRequest(chat map[string]any) map[string]any {
	var input []any
	for _, raw := range Slice(chat["messages"]) {
		m := Map(raw)
		role := Str(m["role"])
		switch role {
		case "system", "developer":
			input = append(input, map[string]any{
				"type": "message", "role": "system",
				"content": []any{map[string]any{"type": "input_text", "text": Text(m["content"])}},
			})
		case "user":
			input = append(input, map[string]any{
				"type": "message", "role": "user",
				"content": responsesContentFromChat(m["content"]),
			})
		case "assistant":
			if text := Text(m["content"]); text != "" {
				input = append(input, map[string]any{
					"type": "message", "role": "assistant",
					"content": []any{map[string]any{"type": "output_text", "text": text}},
				})
			}
			for _, tcRaw := range Slice(m["tool_calls"]) {
				tc := Map(tcRaw)
				fn := Map(tc["function"])
				input = append(input, map[string]any{
					"type": "function_call", "call_id": Str(tc["id"]),
					"name": Str(fn["name"]), "arguments": Str(fn["arguments"]),
				})
			}
		case "tool":
			input = append(input, map[string]any{
				"type": "function_call_output", "call_id": Str(m["tool_call_id"]),
				"output": Text(m["content"]),
			})
		}
	}
	out := map[string]any{"model": chat["model"], "input": input}
	if v, ok := chat["max_tokens"]; ok {
		out["max_output_tokens"] = v
	}
	for _, k := range []string{"temperature", "top_p", "parallel_tool_calls", "user"} {
		if v, ok := chat[k]; ok {
			out[k] = v
		}
	}
	if tools := chatToolsToResponses(chat["tools"]); len(tools) > 0 {
		out["tools"] = tools
		if tc, ok := chat["tool_choice"]; ok {
			out["tool_choice"] = tc
		}
	}
	if b, ok := chat["stream"].(bool); ok {
		out["stream"] = b
	}
	return out
}

func responsesContentFromChat(v any) []any {
	switch c := v.(type) {
	case string:
		return []any{map[string]any{"type": "input_text", "text": c}}
	case []any:
		var out []any
		for _, raw := range c {
			p := Map(raw)
			switch Str(p["type"]) {
			case "text", "input_text", "output_text":
				out = append(out, map[string]any{"type": "input_text", "text": Str(p["text"])})
			case "image_url":
				if u := imageURL(p); u != "" {
					out = append(out, map[string]any{"type": "input_image", "image_url": u})
				}
			}
		}
		return out
	}
	return nil
}

func chatToolsToResponses(v any) []any {
	var out []any
	for _, raw := range Slice(v) {
		t := Map(raw)
		fn := Map(t["function"])
		name := firstNonEmpty(Str(fn["name"]), Str(t["name"]))
		if name == "" {
			continue
		}
		out = append(out, map[string]any{
			"type": "function", "name": name,
			"description": firstNonEmpty(Str(fn["description"]), Str(t["description"])),
			"parameters":  fn["parameters"],
		})
	}
	return out
}

func mergeAssistantCall(messages *[]any, call map[string]any) {
	if n := len(*messages); n > 0 {
		prev := Map((*messages)[n-1])
		if Str(prev["role"]) == "assistant" {
			prev["tool_calls"] = append(Slice(prev["tool_calls"]), call)
			if _, ok := prev["content"]; !ok {
				prev["content"] = nil
			}
			return
		}
	}
	*messages = append(*messages, map[string]any{
		"role": "assistant", "content": nil, "tool_calls": []any{call},
	})
}

func responsesContentToChat(v any) any {
	switch c := v.(type) {
	case string:
		return c
	case []any:
		var out []any
		for _, raw := range c {
			p := Map(raw)
			switch Str(p["type"]) {
			case "input_text", "output_text", "text":
				out = append(out, map[string]any{"type": "text", "text": Str(p["text"])})
			case "input_image":
				if u := Str(p["image_url"]); u != "" {
					out = append(out, map[string]any{"type": "image_url", "image_url": map[string]any{"url": u}})
				}
			}
		}
		return out
	}
	return ""
}

func responsesToolsToChat(v any) []any {
	var out []any
	for _, raw := range Slice(v) {
		t := Map(raw)
		if Str(t["type"]) != "function" {
			continue
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        Str(t["name"]),
				"description": Str(t["description"]),
				"parameters":  t["parameters"],
			},
		})
	}
	return out
}

func ChatToResponsesResponse(chat map[string]any, model, id string) map[string]any {
	choices := Slice(chat["choices"])
	var output []any
	var text strings.Builder
	status := "completed"
	if len(choices) > 0 {
		choice := Map(choices[0])
		msg := Map(choice["message"])
		text.WriteString(Text(msg["content"]))
		if text.Len() > 0 {
			output = append(output, MessageItem(text.String(), "completed"))
		}
		for _, tcRaw := range Slice(msg["tool_calls"]) {
			tc := Map(tcRaw)
			fn := Map(tc["function"])
			output = append(output, map[string]any{
				"id":        firstNonEmpty(Str(tc["id"]), NewID("fc_")),
				"type":      "function_call",
				"status":    "completed",
				"call_id":   firstNonEmpty(Str(tc["id"]), NewID("call_")),
				"name":      Str(fn["name"]),
				"arguments": Str(fn["arguments"]),
			})
		}
		if Str(choice["finish_reason"]) == "length" {
			status = "incomplete"
		}
	}
	usage := Map(chat["usage"])
	out := map[string]any{
		"id":         firstNonEmpty(id, NewID("resp_")),
		"object":     "response",
		"created_at": nowUnix(),
		"status":     status,
		"model":      model,
		"output":     output,
		"output_text": text.String(),
		"usage": map[string]any{
			"input_tokens":  Int(usage["prompt_tokens"]),
			"output_tokens": Int(usage["completion_tokens"]),
			"total_tokens":  Int(usage["total_tokens"]),
		},
	}
	if status == "incomplete" {
		out["incomplete_details"] = map[string]any{"reason": "max_output_tokens"}
	}
	return out
}

func MessageItem(text, status string) map[string]any {
	return map[string]any{
		"id":     NewID("msg_"),
		"type":   "message",
		"status": status,
		"role":   "assistant",
		"content": []any{map[string]any{
			"type": "output_text", "text": text, "annotations": []any{},
		}},
	}
}

// ResponsesToChatResponse is used when the downstream asks Chat Completions but
// the upstream only speaks the Responses API.
func ResponsesToChatResponse(resp map[string]any, model string) map[string]any {
	var text strings.Builder
	var toolCalls []any
	for _, raw := range Slice(resp["output"]) {
		item := Map(raw)
		switch Str(item["type"]) {
		case "message":
			for _, c := range Slice(item["content"]) {
				part := Map(c)
				if Str(part["type"]) == "output_text" {
					text.WriteString(Str(part["text"]))
				}
			}
		case "function_call":
			toolCalls = append(toolCalls, map[string]any{
				"id":   firstNonEmpty(Str(item["call_id"]), Str(item["id"])),
				"type": "function",
				"function": map[string]any{
					"name":      Str(item["name"]),
					"arguments": Str(item["arguments"]),
				},
			})
		}
	}
	message := map[string]any{"role": "assistant", "content": text.String()}
	finish := "stop"
	if len(toolCalls) > 0 {
		message["tool_calls"] = toolCalls
		message["content"] = nil
		finish = "tool_calls"
	}
	usage := Map(resp["usage"])
	return map[string]any{
		"id":      firstNonEmpty(Str(resp["id"]), NewID("chatcmpl_")),
		"object":  "chat.completion",
		"created": nowUnix(),
		"model":   model,
		"choices": []any{map[string]any{
			"index": 0, "message": message, "logprobs": nil, "finish_reason": finish,
		}},
		"usage": map[string]any{
			"prompt_tokens":     Int(usage["input_tokens"]),
			"completion_tokens": Int(usage["output_tokens"]),
			"total_tokens":      Int(usage["total_tokens"]),
		},
	}
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
