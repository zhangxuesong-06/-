package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"apx2/internal/auth"
	"apx2/internal/budget"
	"apx2/internal/config"
	"apx2/internal/protocol"
	"apx2/internal/router"
	"apx2/internal/upstream"
)

const Version = "2.0.0-dev"

func authFor(p config.Provider) auth.Resolver { return auth.Build(p) }

type call struct {
	downstream string // chat | responses
	model      string
	stream     bool
	buffered   bool
	res        router.Resolution

	original     map[string]any
	chatBody     map[string]any
	chatMessages []map[string]any
	chatTools    []map[string]any
	downTools    []map[string]any
	degraded     []string
}

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "apx_method_not_allowed", "only POST")
		return
	}
	body, err := decodeBody(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "apx_bad_json", err.Error())
		return
	}
	messages := asMessages(body["messages"])
	if len(messages) == 0 {
		writeError(w, http.StatusBadRequest, "apx_bad_request", "messages 不能为空")
		return
	}
	tools := asTools(body["tools"])
	requested := protocol.Str(body["model"])
	res, err := s.rt.Resolve(requested)
	if err != nil {
		writeError(w, http.StatusNotFound, "apx_model_not_found", err.Error())
		return
	}

	trim := budget.Trim(messages, tools, budget.Limits{
		MaxInputChars: s.cfg.Limits.MaxInputChars,
		MaxTools:      s.cfg.Limits.MaxTools,
		PriorityTools: s.cfg.Limits.PriorityTools,
	})
	chatBody := cloneMap(body)
	chatBody["messages"] = toAnyMessages(trim.Messages)
	if len(trim.Tools) > 0 {
		chatBody["tools"] = toAnyTools(trim.Tools)
	} else {
		delete(chatBody, "tools")
		delete(chatBody, "tool_choice")
	}

	c := &call{
		downstream:   "chat",
		model:        displayModel(requested, res),
		stream:       boolValue(body["stream"]),
		res:          res,
		original:     body,
		chatBody:     chatBody,
		chatMessages: trim.Messages,
		chatTools:    trim.Tools,
		downTools:    trim.Tools,
		degraded:     trim.Degraded,
	}
	c.buffered = s.textToToolActive(c.chatMessages, c.chatTools)
	s.dispatch(w, r, c)
}

func (s *Server) handleResponses(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "apx_method_not_allowed", "only POST")
		return
	}
	body, err := decodeBody(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "apx_bad_json", err.Error())
		return
	}
	requested := protocol.Str(body["model"])
	res, err := s.rt.Resolve(requested)
	if err != nil {
		writeError(w, http.StatusNotFound, "apx_model_not_found", err.Error())
		return
	}
	chatReq := protocol.ResponsesToChatRequest(body)
	chatReq["model"] = displayModel(requested, res)
	messages := asMessages(chatReq["messages"])
	if len(messages) == 0 {
		writeError(w, http.StatusBadRequest, "apx_bad_request", "input 不能为空")
		return
	}
	tools := asTools(chatReq["tools"])
	trim := budget.Trim(messages, tools, budget.Limits{
		MaxInputChars: s.cfg.Limits.MaxInputChars,
		MaxTools:      s.cfg.Limits.MaxTools,
		PriorityTools: s.cfg.Limits.PriorityTools,
	})
	chatBody := cloneMap(chatReq)
	chatBody["messages"] = toAnyMessages(trim.Messages)
	if len(trim.Tools) > 0 {
		chatBody["tools"] = toAnyTools(trim.Tools)
	} else {
		delete(chatBody, "tools")
		delete(chatBody, "tool_choice")
	}

	c := &call{
		downstream:   "responses",
		model:        displayModel(requested, res),
		stream:       boolValue(body["stream"]),
		res:          res,
		original:     body,
		chatBody:     chatBody,
		chatMessages: trim.Messages,
		chatTools:    trim.Tools,
		downTools:    asTools(body["tools"]),
		degraded:     trim.Degraded,
	}
	c.buffered = s.textToToolActive(c.chatMessages, c.chatTools)
	s.dispatch(w, r, c)
}

func displayModel(requested string, res router.Resolution) string {
	if strings.TrimSpace(requested) != "" {
		return requested
	}
	if len(res.Targets) > 0 {
		return res.Targets[0].Provider.ID + "/" + res.Targets[0].Model
	}
	return ""
}

func (c *call) upstreamStream() bool { return c.stream && !c.buffered }

// streamFor decides whether the upstream call can be streamed for this protocol.
// Anthropic and Responses streams can only be consumed by matching downstream
// shapes; otherwise we buffer upstream and re-emit the downstream protocol.
func (c *call) streamFor(protocol string) bool {
	if !c.upstreamStream() {
		return false
	}
	switch protocol {
	case config.ProtocolAnthropic:
		return c.downstream == "chat"
	case config.ProtocolOpenAIResponses:
		return c.downstream == "responses"
	}
	return true
}

func (s *Server) dispatch(w http.ResponseWriter, r *http.Request, c *call) {
	start := time.Now()
	targets := s.rt.Order(c.res)
	if len(targets) == 0 {
		writeError(w, http.StatusBadGateway, "apx_no_target", "没有可用的上游")
		return
	}

	var lastStatus = http.StatusBadGateway
	var lastErr = map[string]any{"message": "所有上游都不可用", "type": "apx_upstream_error", "code": "apx_all_failed"}
	var lastProvider string
	var notes []string

	for i, t := range targets {
		kind, body := buildUpstream(c, t)
		timeout := time.Duration(s.cfg.TimeoutSeconds) * time.Second
		if t.Provider.TimeoutSeconds > 0 {
			timeout = time.Duration(t.Provider.TimeoutSeconds) * time.Second
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		resp, err := s.up.Do(ctx, upstream.Request{
			Provider: t.Provider, Kind: kind, Body: body, Auth: authFor(t.Provider),
		})
		elapsed := time.Since(start)
		if err != nil {
			cancel()
			msg := err.Error()
			s.rt.Record(t.Provider.ID, false, elapsed, msg, 0)
			notes = append(notes, fmt.Sprintf("%s: %s", t.Provider.ID, msg))
			lastProvider, lastStatus = t.Provider.ID, http.StatusBadGateway
			lastErr = map[string]any{"message": msg, "type": "apx_upstream_unreachable", "code": "apx_upstream_unreachable"}
			continue
		}

		if resp.StatusCode != http.StatusOK {
			status, errBody := upstream.ErrorBody(resp)
			cancel()
			msg := errorMessage(errBody, status)
			s.rt.Record(t.Provider.ID, false, elapsed, msg, 0)
			notes = append(notes, fmt.Sprintf("%s: %s", t.Provider.ID, msg))
			lastProvider = t.Provider.ID
			if retryable(status) && i < len(targets)-1 {
				lastStatus = status
				lastErr = map[string]any{"message": msg, "type": "apx_upstream_error", "code": "apx_upstream_" + fmt.Sprint(status)}
				continue
			}
			s.record(RequestRecord{
				At: time.Now().Format(time.RFC3339), Path: r.URL.Path, Model: c.model,
				Provider: t.Provider.ID, Group: c.res.Group, Stream: c.stream,
				Status: status, MS: time.Since(start).Milliseconds(),
				InputChars: c.inputChars(), Code: fmt.Sprintf("upstream_%d", status), Error: msg,
			})
			writeError(w, status, fmt.Sprintf("apx_upstream_%d", status), fmt.Sprintf("%s: %s", t.Provider.ID, msg))
			return
		}

		w.Header().Set("X-Apx-Provider", t.Provider.ID)
		if c.res.Group != "" {
			w.Header().Set("X-Apx-Group", c.res.Group)
		}
		tokens, code := s.render(w, r, c, t, resp)
		cancel()
		_ = code
		s.rt.Record(t.Provider.ID, true, elapsed, "", tokens)
		rec := RequestRecord{
			At: time.Now().Format(time.RFC3339), Path: r.URL.Path, Model: c.model,
			Provider: t.Provider.ID, Group: c.res.Group, Stream: c.stream,
			Status: http.StatusOK, MS: time.Since(start).Milliseconds(),
			InputChars: c.inputChars(), Tokens: tokens,
		}
		if len(c.degraded) > 0 {
			rec.Code = strings.Join(c.degraded, ",")
		}
		if len(notes) > 0 {
			rec.Error = "已回退: " + strings.Join(notes, "; ")
		}
		s.record(rec)
		return
	}

	s.record(RequestRecord{
		At: time.Now().Format(time.RFC3339), Path: r.URL.Path, Model: c.model,
		Provider: lastProvider, Group: c.res.Group, Stream: c.stream,
		Status: lastStatus, MS: time.Since(start).Milliseconds(),
		InputChars: c.inputChars(), Code: "apx_all_failed", Error: strings.Join(notes, "; "),
	})
	writeError(w, lastStatus, "apx_all_failed", fmt.Sprint(lastErr["message"]))
}

func buildUpstream(c *call, t router.Target) (string, map[string]any) {
	switch t.Provider.Protocol {
	case config.ProtocolAnthropic:
		body := protocol.ChatToAnthropic(c.chatBody)
		body["model"] = t.Model
		body["stream"] = c.streamFor(config.ProtocolAnthropic)
		return "messages", body
	case config.ProtocolOpenAIResponses:
		body := protocol.ChatToResponsesRequest(c.chatBody)
		body["model"] = t.Model
		body["stream"] = c.streamFor(config.ProtocolOpenAIResponses)
		for _, k := range []string{"reasoning", "text", "truncation", "include", "store", "previous_response_id"} {
			if v, ok := c.original[k]; ok {
				body[k] = v
			}
		}
		return "responses", body
	default:
		body := cloneMap(c.chatBody)
		body["model"] = t.Model
		body["stream"] = c.upstreamStream()
		return "chat", body
	}
}

func (s *Server) render(w http.ResponseWriter, r *http.Request, c *call, t router.Target, resp *http.Response) (int, string) {
	defer resp.Body.Close()

	switch t.Provider.Protocol {
	case config.ProtocolAnthropic:
		if c.streamFor(config.ProtocolAnthropic) {
			streamHeaders(w)
			flush := flusher(w)
			_ = protocol.StreamAnthropicToChat(resp.Body, w, flush, c.model)
			return 0, ""
		}
		doc, err := decodeUpstream(resp.Body)
		if err != nil {
			writeError(w, http.StatusBadGateway, "apx_upstream_shape", err.Error())
			return 0, "shape"
		}
		chat := protocol.AnthropicToChat(doc, t.Model)
		if c.downstream == "responses" {
			chat, degraded := s.maybeTextToTool(c.chatMessages, c.chatTools, chat)
			c.degraded = append(c.degraded, degraded...)
			respObj := protocol.ChatToResponsesResponse(chat, c.model, protocol.NewID("resp_"))
			if c.stream {
				streamHeaders(w)
				emitResponsesSSE(w, flusher(w), respObj, protocol.Str(respObj["id"]))
			} else {
				writeJSON(w, http.StatusOK, respObj)
			}
			return usageTokens(chat), ""
		}
		return s.writeChat(w, c, t, chat)

	case config.ProtocolOpenAIResponses:
		if c.streamFor(config.ProtocolOpenAIResponses) {
			streamHeaders(w)
			_, _ = io.Copy(w, resp.Body)
			if f := flusher(w); f != nil {
				f()
			}
			return 0, ""
		}
		doc, err := decodeUpstream(resp.Body)
		if err != nil {
			writeError(w, http.StatusBadGateway, "apx_upstream_shape", err.Error())
			return 0, "shape"
		}
		if c.downstream == "responses" {
			doc["model"] = c.model
			if c.stream {
				streamHeaders(w)
				emitResponsesSSE(w, flusher(w), doc, protocol.NewID("resp_"))
				return usageTokensFromResponses(doc), ""
			}
			writeJSON(w, http.StatusOK, doc)
			return usageTokensFromResponses(doc), ""
		}
		chat := protocol.ResponsesToChatResponse(doc, t.Model)
		return s.writeChat(w, c, t, chat)

	default:
		if c.downstream == "chat" && c.streamFor(config.ProtocolOpenAIChat) {
			streamHeaders(w)
			_ = protocol.StreamRewriteModel(resp.Body, w, flusher(w), c.model)
			return 0, ""
		}
		if c.downstream == "responses" && c.streamFor(config.ProtocolOpenAIChat) {
			streamHeaders(w)
			_ = protocol.StreamChatToResponses(resp.Body, w, flusher(w), c.model, protocol.NewID("resp_"))
			return 0, ""
		}
		doc, err := decodeUpstream(resp.Body)
		if err != nil {
			writeError(w, http.StatusBadGateway, "apx_upstream_shape", err.Error())
			return 0, "shape"
		}
		if c.downstream == "responses" {
			var degraded []string
			doc, degraded = s.maybeTextToTool(c.chatMessages, c.chatTools, doc)
			c.degraded = append(c.degraded, degraded...)
			respObj := protocol.ChatToResponsesResponse(doc, c.model, protocol.NewID("resp_"))
			if c.stream {
				streamHeaders(w)
				emitResponsesSSE(w, flusher(w), respObj, protocol.Str(respObj["id"]))
			} else {
				writeJSON(w, http.StatusOK, respObj)
			}
			return usageTokens(doc), ""
		}
		return s.writeChat(w, c, t, doc)
	}
}

func (s *Server) writeChat(w http.ResponseWriter, c *call, t router.Target, chat map[string]any) (int, string) {
	chat, degraded := s.maybeTextToTool(c.chatMessages, c.chatTools, chat)
	c.degraded = append(c.degraded, degraded...)
	chat["model"] = c.model
	meta := map[string]any{
		"provider": t.Provider.ID, "group": c.res.Group,
		"degraded": c.degraded,
	}
	if c.stream {
		streamHeaders(w)
		emitChatSSE(w, flusher(w), chat, c.model, meta)
		return usageTokens(chat), ""
	}
	chat["apx"] = meta
	writeJSON(w, http.StatusOK, chat)
	return usageTokens(chat), ""
}

func emitChatSSE(w io.Writer, flush func(), chat map[string]any, model string, meta map[string]any) {
	choices := protocol.Slice(chat["choices"])
	var delta, finish any = map[string]any{}, "stop"
	if len(choices) > 0 {
		choice := protocol.Map(choices[0])
		finish = choice["finish_reason"]
		msg := protocol.Map(choice["message"])
		delta = map[string]any{"role": "assistant"}
		if text := protocol.Text(msg["content"]); text != "" {
			delta.(map[string]any)["content"] = text
		}
		if calls := protocol.Slice(msg["tool_calls"]); len(calls) > 0 {
			var out []any
			for i, raw := range calls {
				call := protocol.Map(raw)
				out = append(out, map[string]any{
					"index": i, "id": protocol.Str(call["id"]), "type": "function",
					"function": call["function"],
				})
			}
			delta.(map[string]any)["tool_calls"] = out
		}
	}
	chunk := map[string]any{
		"id": protocol.NewID("chatcmpl-"), "object": "chat.completion.chunk",
		"created": time.Now().Unix(), "model": model,
		"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": nil}},
		"apx":     meta,
	}
	_ = protocol.WriteSSE(w, "", chunk)
	final := map[string]any{
		"id": protocol.NewID("chatcmpl-"), "object": "chat.completion.chunk",
		"created": time.Now().Unix(), "model": model,
		"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": finish}},
		"usage":   chat["usage"],
	}
	_ = protocol.WriteSSE(w, "", final)
	_ = protocol.WriteSSE(w, "", "[DONE]")
	if flush != nil {
		flush()
	}
}

func emitResponsesSSE(w io.Writer, flush func(), resp map[string]any, id string) {
	if id != "" {
		resp["id"] = id
	}
	seq := 0
	next := func() int { seq++; return seq }
	send := func(event string, v any) {
		protocol.Map(v)["sequence_number"] = next()
		_ = protocol.WriteSSE(w, event, v)
		if flush != nil {
			flush()
		}
	}
	created := map[string]any{
		"id": resp["id"], "object": "response", "created_at": time.Now().Unix(),
		"status": "in_progress", "model": resp["model"], "output": []any{},
	}
	send("response.created", map[string]any{"type": "response.created", "response": created})
	send("response.in_progress", map[string]any{"type": "response.in_progress", "response": created})
	for i, raw := range protocol.Slice(resp["output"]) {
		item := protocol.Map(raw)
		send("response.output_item.added", map[string]any{
			"type": "response.output_item.added", "output_index": i, "item": item,
		})
		if protocol.Str(item["type"]) == "message" {
			for _, c := range protocol.Slice(item["content"]) {
				part := protocol.Map(c)
				if protocol.Str(part["type"]) == "output_text" {
					send("response.output_text.delta", map[string]any{
						"type": "response.output_text.delta", "item_id": item["id"],
						"output_index": i, "content_index": 0, "delta": part["text"],
					})
				}
			}
		}
		send("response.output_item.done", map[string]any{
			"type": "response.output_item.done", "output_index": i, "item": item,
		})
	}
	send("response.completed", map[string]any{"type": "response.completed", "response": resp})
}

func streamHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
}

func flusher(w http.ResponseWriter) func() {
	f, ok := w.(http.Flusher)
	if !ok {
		return nil
	}
	return f.Flush
}

func decodeUpstream(r io.Reader) (map[string]any, error) {
	raw, err := io.ReadAll(io.LimitReader(r, 32<<20))
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("上游返回的不是 JSON：%s", snippet(raw))
	}
	return doc, nil
}

func usageTokens(chat map[string]any) int {
	return protocol.Int(protocol.Map(chat["usage"])["total_tokens"])
}

func usageTokensFromResponses(resp map[string]any) int {
	return protocol.Int(protocol.Map(resp["usage"])["total_tokens"])
}

func errorMessage(body map[string]any, status int) string {
	if e := protocol.Map(body["error"]); len(e) > 0 {
		if msg := protocol.Str(e["message"]); msg != "" {
			return msg
		}
	}
	if msg := protocol.Str(body["message"]); msg != "" {
		return msg
	}
	return fmt.Sprintf("上游返回 HTTP %d", status)
}

func retryable(status int) bool {
	switch status {
	case 401, 403, 404, 408, 409, 425, 429:
		return true
	}
	return status >= 500
}

func (c *call) inputChars() int {
	b, _ := json.Marshal(c.chatMessages)
	return len(b)
}

func boolValue(v any) bool {
	b, _ := v.(bool)
	return b
}

func snippet(raw []byte) string {
	s := strings.TrimSpace(string(raw))
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}

func toAnyMessages(in []map[string]any) []any {
	out := make([]any, 0, len(in))
	for _, m := range in {
		out = append(out, m)
	}
	return out
}

func toAnyTools(in []map[string]any) []any {
	out := make([]any, 0, len(in))
	for _, t := range in {
		out = append(out, t)
	}
	return out
}
