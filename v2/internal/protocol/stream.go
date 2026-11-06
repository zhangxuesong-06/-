package protocol

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

func nowUnix() int64 { return time.Now().Unix() }

// ---------------------------------------------------------------------------
// SSE primitives
// ---------------------------------------------------------------------------

func ReadSSE(r *bufio.Reader) (string, string, error) {
	var event, data string
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			if data != "" {
				return event, data, nil
			}
			return "", "", err
		}
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			if data != "" {
				return event, data, nil
			}
			event = ""
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			chunk := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if data != "" {
				data += "\n"
			}
			data += chunk
		}
	}
}

func WriteSSE(w io.Writer, event string, v any) error {
	var payload []byte
	switch d := v.(type) {
	case string:
		payload = []byte(d)
	default:
		b, err := json.Marshal(d)
		if err != nil {
			return err
		}
		payload = b
	}
	if event != "" {
		if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintf(w, "data: %s\n\n", payload)
	return err
}

// StreamRewriteModel passes Chat SSE through and replaces the model field.
func StreamRewriteModel(src io.Reader, dst io.Writer, flush func(), model string) error {
	r := bufio.NewReader(src)
	for {
		event, data, err := ReadSSE(r)
		if err != nil {
			return nil
		}
		if data == "[DONE]" {
			_ = WriteSSE(dst, "", "[DONE]")
			if flush != nil {
				flush()
			}
			return nil
		}
		var doc map[string]any
		if json.Unmarshal([]byte(data), &doc) == nil {
			doc["model"] = model
			_ = WriteSSE(dst, event, doc)
		} else {
			_ = WriteSSE(dst, event, data)
		}
		if flush != nil {
			flush()
		}
	}
}

// ---------------------------------------------------------------------------
// Chat SSE -> Responses SSE
// ---------------------------------------------------------------------------

type toolStream struct {
	index int
	id    string
	name  string
	args  strings.Builder
	added bool
}

type chatToResponses struct {
	w        io.Writer
	flush    func()
	respID   string
	model    string
	created  int64
	seq      int
	text     strings.Builder
	textID   string
	textAdd  bool
	tools    map[int]*toolStream
	toolSeq  []int
	finish   string
	usage    map[string]any
	done     bool
	outputIdx int
}

func StreamChatToResponses(src io.Reader, dst io.Writer, flush func(), model, respID string) error {
	s := &chatToResponses{
		w: dst, flush: flush, respID: respID, model: model,
		created: nowUnix(), tools: map[int]*toolStream{},
	}
	s.emit("response.created", map[string]any{
		"type": "response.created", "sequence_number": s.next(),
		"response": s.responseObject("in_progress", nil),
	})
	s.emit("response.in_progress", map[string]any{
		"type": "response.in_progress", "sequence_number": s.next(),
		"response": s.responseObject("in_progress", nil),
	})

	r := bufio.NewReader(src)
	for {
		event, data, err := ReadSSE(r)
		if err != nil {
			break
		}
		if data == "[DONE]" {
			break
		}
		var chunk map[string]any
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		if u := Map(chunk["usage"]); len(u) > 0 {
			s.usage = u
		}
		for _, raw := range Slice(chunk["choices"]) {
			choice := Map(raw)
			if fr := Str(choice["finish_reason"]); fr != "" {
				s.finish = fr
			}
			delta := Map(choice["delta"])
			if content, ok := delta["content"].(string); ok && content != "" {
				s.textDelta(content)
			}
			for _, tcRaw := range Slice(delta["tool_calls"]) {
				s.toolDelta(Map(tcRaw))
			}
		}
		_ = event
	}
	s.finishStream()
	return nil
}

func (s *chatToResponses) next() int {
	s.seq++
	return s.seq
}

func (s *chatToResponses) emit(event string, v any) {
	_ = WriteSSE(s.w, event, v)
	if s.flush != nil {
		s.flush()
	}
}

func (s *chatToResponses) responseObject(status string, output []any) map[string]any {
	obj := map[string]any{
		"id":         s.respID,
		"object":     "response",
		"created_at": s.created,
		"status":     status,
		"model":      s.model,
		"output":     output,
		"usage":      s.usageObject(),
	}
	if status == "incomplete" {
		obj["incomplete_details"] = map[string]any{"reason": "max_output_tokens"}
	}
	return obj
}

func (s *chatToResponses) usageObject() map[string]any {
	u := s.usage
	return map[string]any{
		"input_tokens":  Int(u["prompt_tokens"]),
		"output_tokens": Int(u["completion_tokens"]),
		"total_tokens":  Int(u["total_tokens"]),
	}
}

func (s *chatToResponses) textDelta(content string) {
	if !s.textAdd {
		s.textAdd = true
		s.textID = NewID("msg_")
		s.emit("response.output_item.added", map[string]any{
			"type": "response.output_item.added", "sequence_number": s.next(),
			"output_index": s.outputIdx,
			"item": map[string]any{
				"id": s.textID, "type": "message", "status": "in_progress",
				"role": "assistant", "content": []any{},
			},
		})
		s.emit("response.content_part.added", map[string]any{
			"type": "response.content_part.added", "sequence_number": s.next(),
			"item_id": s.textID, "output_index": s.outputIdx, "content_index": 0,
			"part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}},
		})
	}
	s.text.WriteString(content)
	s.emit("response.output_text.delta", map[string]any{
		"type": "response.output_text.delta", "sequence_number": s.next(),
		"item_id": s.textID, "output_index": s.outputIdx, "content_index": 0,
		"delta": content,
	})
}

func (s *chatToResponses) toolDelta(tc map[string]any) {
	index := Int(tc["index"])
	t, ok := s.tools[index]
	if !ok {
		t = &toolStream{index: index}
		s.tools[index] = t
		s.toolSeq = append(s.toolSeq, index)
	}
	if id := Str(tc["id"]); id != "" {
		t.id = id
	}
	fn := Map(tc["function"])
	if name := Str(fn["name"]); name != "" {
		t.name = name
	}
	if !t.added && (t.name != "" || t.id != "") {
		t.added = true
		s.outputIdx++
		if t.id == "" {
			t.id = NewID("call_")
		}
		s.emit("response.output_item.added", map[string]any{
			"type": "response.output_item.added", "sequence_number": s.next(),
			"output_index": s.outputIdx,
			"item": map[string]any{
				"id": t.id, "type": "function_call", "status": "in_progress",
				"call_id": t.id, "name": t.name, "arguments": "",
			},
		})
	}
	if args := Str(fn["arguments"]); args != "" {
		t.args.WriteString(args)
		s.emit("response.function_call_arguments.delta", map[string]any{
			"type": "response.function_call_arguments.delta", "sequence_number": s.next(),
			"item_id": t.id, "output_index": s.outputIdx, "delta": args,
		})
	}
}

func (s *chatToResponses) finishStream() {
	if s.done {
		return
	}
	s.done = true
	var output []any
	if s.textAdd {
		outIdx := 0
		s.emit("response.output_text.done", map[string]any{
			"type": "response.output_text.done", "sequence_number": s.next(),
			"item_id": s.textID, "output_index": outIdx, "content_index": 0,
			"text": s.text.String(),
		})
		s.emit("response.content_part.done", map[string]any{
			"type": "response.content_part.done", "sequence_number": s.next(),
			"item_id": s.textID, "output_index": outIdx, "content_index": 0,
			"part": map[string]any{"type": "output_text", "text": s.text.String(), "annotations": []any{}},
		})
		item := MessageItem(s.text.String(), "completed")
		item["id"] = s.textID
		s.emit("response.output_item.done", map[string]any{
			"type": "response.output_item.done", "sequence_number": s.next(),
			"output_index": outIdx, "item": item,
		})
		output = append(output, item)
	}
	base := len(output)
	for i, idx := range s.toolSeq {
		t := s.tools[idx]
		if !t.added {
			continue
		}
		outIdx := base + i
		s.emit("response.function_call_arguments.done", map[string]any{
			"type": "response.function_call_arguments.done", "sequence_number": s.next(),
			"item_id": t.id, "output_index": outIdx, "arguments": t.args.String(),
		})
		item := map[string]any{
			"id": t.id, "type": "function_call", "status": "completed",
			"call_id": t.id, "name": t.name, "arguments": t.args.String(),
		}
		s.emit("response.output_item.done", map[string]any{
			"type": "response.output_item.done", "sequence_number": s.next(),
			"output_index": outIdx, "item": item,
		})
		output = append(output, item)
	}
	status := "completed"
	if s.finish == "length" {
		status = "incomplete"
	}
	s.emit("response.completed", map[string]any{
		"type": "response.completed", "sequence_number": s.next(),
		"response": s.responseObject(status, output),
	})
}

// ---------------------------------------------------------------------------
// Anthropic SSE -> Chat SSE
// ---------------------------------------------------------------------------

func StreamAnthropicToChat(src io.Reader, dst io.Writer, flush func(), model string) error {
	r := bufio.NewReader(src)
	started := false
	toolIndex := map[int]int{}
	nextTool := 0
	send := func(delta map[string]any, finish any) {
		chunk := map[string]any{
			"id": NewID("chatcmpl_"), "object": "chat.completion.chunk",
			"created": nowUnix(), "model": model,
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
		}
		_ = WriteSSE(dst, "", chunk)
		if flush != nil {
			flush()
		}
	}
	for {
		event, data, err := ReadSSE(r)
		if err != nil {
			break
		}
		var doc map[string]any
		if json.Unmarshal([]byte(data), &doc) != nil {
			continue
		}
		if event == "" {
			event = Str(doc["type"])
		}
		switch event {
		case "message_start":
			if !started {
				started = true
				send(map[string]any{"role": "assistant", "content": ""}, nil)
			}
		case "content_block_start":
			block := Map(doc["content_block"])
			if Str(block["type"]) == "tool_use" {
				idx := Int(doc["index"])
				ti := nextTool
				nextTool++
				toolIndex[idx] = ti
				send(map[string]any{"tool_calls": []any{map[string]any{
					"index": ti, "id": Str(block["id"]), "type": "function",
					"function": map[string]any{"name": Str(block["name"]), "arguments": ""},
				}}}, nil)
			}
		case "content_block_delta":
			delta := Map(doc["delta"])
			switch Str(delta["type"]) {
			case "text_delta":
				send(map[string]any{"content": Str(delta["text"])}, nil)
			case "input_json_delta":
				ti := toolIndex[Int(doc["index"])]
				send(map[string]any{"tool_calls": []any{map[string]any{
					"index":    ti,
					"function": map[string]any{"arguments": Str(delta["partial_json"])},
				}}}, nil)
			}
		case "message_delta":
			finish := "stop"
			d := Map(doc["delta"])
			switch Str(d["stop_reason"]) {
			case "tool_use":
				finish = "tool_calls"
			case "max_tokens":
				finish = "length"
			}
			chunk := map[string]any{
				"id": NewID("chatcmpl_"), "object": "chat.completion.chunk",
				"created": nowUnix(), "model": model,
				"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": finish}},
			}
			if usage := Map(doc["usage"]); len(usage) > 0 {
				chunk["usage"] = map[string]any{
					"prompt_tokens":     Int(usage["input_tokens"]),
					"completion_tokens": Int(usage["output_tokens"]),
					"total_tokens":      Int(usage["input_tokens"]) + Int(usage["output_tokens"]),
				}
			}
			_ = WriteSSE(dst, "", chunk)
			if flush != nil {
				flush()
			}
		case "message_stop":
			_ = WriteSSE(dst, "", "[DONE]")
			if flush != nil {
				flush()
			}
			return nil
		}
	}
	_ = WriteSSE(dst, "", "[DONE]")
	if flush != nil {
		flush()
	}
	return nil
}
