package upstream

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"apx2/internal/auth"
	"apx2/internal/config"
)

func isWorkBuddyProvider(p config.Provider) bool {
	if strings.HasPrefix(p.Auth.Type, "workbuddy") {
		return true
	}
	for _, a := range p.Accounts {
		t := a.Auth.Type
		if t == "" {
			t = p.Auth.Type
		}
		if strings.HasPrefix(t, "workbuddy") {
			return true
		}
	}
	return false
}

// listWorkBuddyModels reads WorkBuddy's own /v3/config, as its client does,
// instead of the generic /v1/models that WorkBuddy does not serve.
func (c *Client) listWorkBuddyModels(ctx context.Context, p config.Provider, resolver auth.Resolver, timeout time.Duration) ([]config.Model, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	root := strings.TrimRight(p.BaseURL, "/")
	root = strings.TrimSuffix(root, "/v2")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, root+"/v3/config", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	if resolver != nil {
		headers, err := resolver(ctx)
		if err != nil {
			return nil, err
		}
		for k, v := range headers {
			if v != "" {
				req.Header.Set(k, v)
			}
		}
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	var doc struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			Agents []struct {
				Name   string   `json:"name"`
				Models []string `json:"models"`
			} `json:"agents"`
			Models []struct {
				ID              string `json:"id"`
				Name            string `json:"name"`
				MaxInputTokens  int    `json:"maxInputTokens"`
				MaxOutputTokens int    `json:"maxOutputTokens"`
				SupportsImages  bool   `json:"supportsImages"`
			} `json:"models"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("WorkBuddy /v3/config: %s", snippet(raw))
	}
	if resp.StatusCode != http.StatusOK || doc.Code != 0 {
		msg := doc.Msg
		if msg == "" {
			msg = snippet(raw)
		}
		return nil, fmt.Errorf("WorkBuddy /v3/config: HTTP %d, code %d: %s", resp.StatusCode, doc.Code, msg)
	}
	byID := map[string]config.Model{}
	for _, m := range doc.Data.Models {
		if m.ID == "" {
			continue
		}
		byID[m.ID] = config.Model{
			ID: m.ID, Name: firstNonEmpty(m.Name, m.ID),
			ContextWindow: m.MaxInputTokens, MaxOutputTokens: m.MaxOutputTokens,
			Protocol: claudeProtocol(m.ID),
		}
	}
	var ids []string
	for _, a := range doc.Data.Agents {
		if a.Name == "cli" {
			ids = a.Models
			break
		}
	}
	if len(ids) == 0 {
		for _, m := range doc.Data.Models {
			if m.ID != "" {
				ids = append(ids, m.ID)
			}
		}
	}
	out := make([]config.Model, 0, len(ids))
	for _, id := range ids {
		if m, ok := byID[id]; ok {
			out = append(out, m)
		} else if id != "" {
			out = append(out, config.Model{ID: id, Name: id, Protocol: claudeProtocol(id)})
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("WorkBuddy /v3/config 没有 cli 模型")
	}
	return out, nil
}

func claudeProtocol(id string) string {
	if strings.HasPrefix(id, "claude-") {
		return config.ProtocolAnthropic
	}
	return ""
}
