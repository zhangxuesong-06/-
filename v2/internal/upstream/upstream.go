// Package upstream builds and sends the actual provider requests. It knows the
// three wire protocols apx speaks and nothing about routing or HTTP clients.
package upstream

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"apx2/internal/auth"
	"apx2/internal/config"
)

type Client struct {
	HTTP *http.Client
}

func NewClient(timeout time.Duration) *Client {
	return &Client{HTTP: &http.Client{Timeout: timeout}}
}

// Endpoint resolves a logical endpoint (chat, responses, models, messages) for a
// provider, honouring explicit paths before protocol defaults.
func Endpoint(p config.Provider, kind string) string {
	if p.Paths != nil {
		if path, ok := p.Paths[kind]; ok && path != "" {
			return join(p.BaseURL, path)
		}
	}
	switch p.Protocol {
	case config.ProtocolAnthropic:
		switch kind {
		case "models":
			return root(p.BaseURL) + "/v1/models"
		default:
			return root(p.BaseURL) + "/v1/messages"
		}
	case config.ProtocolOpenAIResponses:
		if kind == "models" {
			return root(p.BaseURL) + "/models"
		}
		return root(p.BaseURL) + "/responses"
	default:
		if kind == "models" {
			return root(p.BaseURL) + "/models"
		}
		return root(p.BaseURL) + "/chat/completions"
	}
}

func join(base, path string) string {
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}

// root normalises a base URL to an OpenAI-style API root. Bases that already end
// in /v1 or a version-like segment are left untouched.
func root(base string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, "/v1") {
		return base
	}
	return base + "/v1"
}

type Request struct {
	Provider config.Provider
	Kind     string // chat | responses | models | messages
	Method   string
	Body     any
	Auth     auth.Resolver
}

func (c *Client) Do(ctx context.Context, r Request) (*http.Response, error) {
	if r.Method == "" {
		r.Method = http.MethodPost
	}
	var body io.Reader
	if r.Body != nil {
		b, err := json.Marshal(r.Body)
		if err != nil {
			return nil, err
		}
		body = strings.NewReader(string(b))
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, Endpoint(r.Provider, r.Kind), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept-Encoding", "identity")
	if r.Auth != nil {
		headers, err := r.Auth(ctx)
		if err != nil {
			return nil, err
		}
		for k, v := range headers {
			if v != "" {
				req.Header.Set(k, v)
			}
		}
	}
	for k, v := range r.Provider.Headers {
		req.Header.Set(k, v)
	}
	client := c.HTTP
	if r.Provider.TimeoutSeconds > 0 {
		client = &http.Client{Timeout: time.Duration(r.Provider.TimeoutSeconds) * time.Second}
	}
	return client.Do(req)
}

func (c *Client) ListModels(ctx context.Context, p config.Provider, resolver auth.Resolver, timeout time.Duration) ([]config.Model, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	resp, err := c.Do(ctx, Request{Provider: p, Kind: "models", Method: http.MethodGet, Auth: resolver})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET models: %s: %s", resp.Status, snippet(raw))
	}
	var doc struct {
		Data []struct {
			ID             string `json:"id"`
			Name           string `json:"name"`
			DisplayName    string `json:"display_name"`
			ContextLength  int    `json:"context_length"`
			MaxInputTokens int    `json:"max_input_tokens"`
			MaxOutput      int    `json:"max_output_tokens"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	out := make([]config.Model, 0, len(doc.Data))
	for _, m := range doc.Data {
		if m.ID == "" {
			continue
		}
		cw := m.ContextLength
		if cw == 0 {
			cw = m.MaxInputTokens
		}
		out = append(out, config.Model{
			ID:              m.ID,
			Name:            firstNonEmpty(m.DisplayName, m.Name, m.ID),
			ContextWindow:   cw,
			MaxOutputTokens: m.MaxOutput,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// ErrorBody turns an upstream error into an OpenAI-shaped error envelope while
// preserving the upstream message and status.
func ErrorBody(resp *http.Response) (int, map[string]any) {
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		doc = map[string]any{"error": map[string]any{
			"message": snippet(raw),
			"type":    "apx_upstream_error",
		}}
	}
	return resp.StatusCode, doc
}

func snippet(raw []byte) string {
	s := strings.TrimSpace(string(raw))
	if len(s) > 400 {
		return s[:400] + "…"
	}
	return s
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
