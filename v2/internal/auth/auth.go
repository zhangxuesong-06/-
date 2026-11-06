// Package auth turns a provider's auth declaration into request headers.
//
// The v2 rule is the same as v1 and the same as magpie's: credentials belong to
// another app. We read them on every request so the owning app can refresh them
// without restarting the gateway. Secrets never leave the process: only the
// resulting headers are passed to net/http.
package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"apx2/internal/config"
)

type Headers map[string]string

type Resolver func(ctx context.Context) (Headers, error)

func Build(p config.Provider) Resolver {
	spec := p.Auth
	switch spec.Type {
	case "", "none":
		return func(context.Context) (Headers, error) { return Headers{}, nil }

	case "bearer":
		return func(context.Context) (Headers, error) {
			token, err := secret(p, spec)
			if err != nil {
				return nil, err
			}
			return Headers{"Authorization": "Bearer " + token}, nil
		}

	case "header":
		return func(context.Context) (Headers, error) {
			token, err := secret(p, spec)
			if err != nil {
				return nil, err
			}
			name := spec.Header
			if name == "" {
				name = "Authorization"
			}
			return Headers{name: spec.Prefix + token}, nil
		}

	case "codex-oauth":
		// Codex's CLI stores a plaintext OAuth bundle. Read it live; while
		// Codex refreshes its token, apx keeps working without a restart.
		return func(context.Context) (Headers, error) {
			path := expandHome(firstNonEmpty(spec.File, "~/.codex/auth.json"))
			token, account, err := codexToken(path)
			if err != nil {
				return nil, err
			}
			return Headers{
				"Authorization":     "Bearer " + token,
				"chatgpt-account-id": account,
				"originator":        "apx2",
				"user-agent":        "apx2/2.0",
			}, nil
		}

	case "workbuddy-key":
		// WorkBuddy's public API takes the same key three ways. The user id is
		// derived, not stored, which is exactly what WorkBuddy's own clients do.
		return func(context.Context) (Headers, error) {
			key, err := secret(p, spec)
			if err != nil {
				return nil, err
			}
			h := Headers{
				"X-API-Key":     key,
				"Authorization": "Bearer " + key,
				"X-User-Id":     "anonymous_" + tail(key, 8),
			}
			if v := os.Getenv("APX_WORKBUDDY_ENTERPRISE_ID"); v != "" {
				h["X-Enterprise-Id"] = v
			}
			if v := os.Getenv("APX_WORKBUDDY_TENANT_ID"); v != "" {
				h["X-Tenant-Id"] = v
			}
			return h, nil
		}

	case "zcode-key":
		return func(context.Context) (Headers, error) {
			key, err := secret(p, spec)
			if err != nil {
				return nil, err
			}
			if p.Protocol == config.ProtocolAnthropic {
				return Headers{"x-api-key": key, "anthropic-version": "2023-06-01"}, nil
			}
			return Headers{"Authorization": "Bearer " + key}, nil
		}

	case "workbuddy-oauth", "zcode-oauth":
		return func(context.Context) (Headers, error) {
			token, account, err := storedOAuth(p.ID)
			if err != nil {
				return nil, err
			}
			h := Headers{"Authorization": "Bearer " + token}
			if account != "" {
				h["X-User-Id"] = account
			}
			return h, nil
		}
	}
	return func(context.Context) (Headers, error) {
		return nil, fmt.Errorf("未知的 auth.type=%q", spec.Type)
	}
}

// secret resolves a token from, in order: an env var, an explicit file+jsonPath,
// then ~/.apx2/credentials.json. Every step is read-only.
func secret(p config.Provider, spec config.AuthConfig) (string, error) {
	if spec.Env != "" {
		if v := strings.TrimSpace(os.Getenv(spec.Env)); v != "" {
			return v, nil
		}
	}
	if spec.File != "" {
		path := expandHome(spec.File)
		if v, err := readSecretFile(path, spec.JSONPath); err == nil && v != "" {
			return v, nil
		}
	}
	creds := config.CredentialsPath()
	for _, key := range []string{p.ID + ".key", p.ID + ".apiKey", p.ID + ".accessToken"} {
		if v, err := readSecretFile(creds, key); err == nil && v != "" {
			return v, nil
		}
	}
	return "", fmt.Errorf("未找到 %s 的凭据：请运行 `apx auth set %s --key <key>`，或设置环境变量 %s", p.ID, p.ID, firstNonEmpty(spec.Env, "APX_"+strings.ToUpper(p.ID)+"_KEY"))
}

func readSecretFile(path, jsonPath string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(jsonPath) == "" {
		// A .json file without a path means "the only string value".
		var anyValue any
		if json.Unmarshal(raw, &anyValue) == nil {
			if s, ok := anyValue.(string); ok {
				return strings.TrimSpace(s), nil
			}
			return "", fmt.Errorf("%s 是 JSON，需要 jsonPath", path)
		}
		return strings.TrimSpace(string(raw)), nil
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", err
	}
	// apx stores credentials as flat "provider.key" entries; also accept a
	// nested map so hand-written files work too.
	if m, ok := doc.(map[string]any); ok {
		if v, ok := m[jsonPath]; ok {
			if s, ok := v.(string); ok {
				return strings.TrimSpace(s), nil
			}
		}
	}
	cur := doc
	for _, part := range strings.Split(jsonPath, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return "", fmt.Errorf("%s 中不存在 %s", path, jsonPath)
		}
		cur = m[part]
	}
	s, _ := cur.(string)
	return strings.TrimSpace(s), nil
}

func codexToken(path string) (token, account string, err error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", "", fmt.Errorf("读取 Codex 凭据失败：%w", err)
	}
	var doc struct {
		Tokens struct {
			AccessToken string `json:"access_token"`
			AccountID   string `json:"account_id"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	if doc.Tokens.AccessToken == "" {
		return "", "", fmt.Errorf("Codex auth.json 没有 tokens.access_token")
	}
	return doc.Tokens.AccessToken, doc.Tokens.AccountID, nil
}

// storedOAuth reads ~/.apx2/auth/<provider>.json, apx's own login store. It is
// deliberately separate from magpie's plugin-auth.json: nothing is shared.
func storedOAuth(provider string) (token, account string, err error) {
	dir, err := config.StateDir()
	if err != nil {
		return "", "", err
	}
	path := filepath.Join(dir, "auth", provider+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", "", fmt.Errorf("%s 未登录；运行 `apx auth import %s` 或 `apx auth set %s --key`", provider, provider, provider)
	}
	var doc struct {
		AccessToken string `json:"access_token"`
		AccountID   string `json:"account_id"`
		ExpiresAt   int64  `json:"expires_at"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	if doc.AccessToken == "" {
		return "", "", fmt.Errorf("%s 的 apx 登录文件缺少 access_token", provider)
	}
	return doc.AccessToken, doc.AccountID, nil
}

// SetSecret stores a key for a provider in apx's own credential file.
func SetSecret(provider, field, value string) error {
	path := config.CredentialsPath()
	doc := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(raw, &doc)
	}
	doc[provider+"."+field] = value
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o600)
}

func expandHome(p string) string {
	if strings.HasPrefix(p, "~") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(p, "~"), string(filepath.Separator)))
	}
	return p
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
