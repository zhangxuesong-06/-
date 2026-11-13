// Package auth turns a provider's auth declaration into request headers.
//
// The v2 rule is the same as v1 and the same as magpie's: credentials belong to
// another app. We read them on every request so the owning app can refresh them
// without restarting the gateway. Secrets never leave the process: only the
// resulting headers are passed to net/http.
package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"apx2/internal/config"
)

type Headers map[string]string

// Identity is the non-secret description of the account behind a provider.
// The UI uses it to show "which account served this request" without ever
// exposing the token itself.
type Identity struct {
	ID    string `json:"id,omitempty"`
	Label string `json:"label"`
	Tail  string `json:"tail,omitempty"`
}

// Describe resolves a provider's account label from the same credential source
// the request would use. It never returns the secret.
func Describe(p config.Provider) Identity {
	return DescribeAccount(p, nil)
}

// DescribeAccount is Describe for one account in a provider's pool.
func DescribeAccount(p config.Provider, acct *config.Account) Identity {
	spec, name := accountSpec(p, acct)
	id := describeSpec(p, spec, name)
	if acct != nil {
		if acct.Name != "" {
			if id.Label == "" || id.Label == "未配置凭据" {
				id.Label = acct.Name
			} else {
				id.Label = acct.Name + " · " + id.Label
			}
		}
		if id.ID == "" {
			id.ID = acct.ID
		}
	}
	return id
}

func describeSpec(p config.Provider, spec config.AuthConfig, name string) Identity {
	switch spec.Type {
	case "", "none":
		return Identity{ID: "local", Label: "本地"}
	case "codex-oauth":
		path := expandHome(firstNonEmpty(spec.File, "~/.codex/auth.json"))
		id, email, err := codexAccount(path)
		if err != nil {
			return Identity{Label: "未配置凭据"}
		}
		label := email
		if label == "" {
			label = "account " + tail(id, 8)
		}
		return Identity{ID: id, Label: label, Tail: tail(id, 8)}
	case "zcode-config":
		path := expandHome(firstNonEmpty(spec.File, "~/.zcode/v2/provider_config.json"))
		key, err := zcodeKey(path)
		if err != nil {
			return Identity{Label: "未配置凭据"}
		}
		return Identity{ID: "key-" + tail(key, 4), Label: "key ····" + tail(key, 4), Tail: tail(key, 4)}
	case "workbuddy-oauth":
		path := expandHome(firstNonEmpty(spec.File, "~/.apx2/auth/workbuddy.json"))
		t, err := LoadWorkBuddyToken(path)
		if err != nil {
			return Identity{Label: "未登录 WorkBuddy"}
		}
		return WorkBuddyTokenIdentity(t)
	}
	key, err := secret(p, spec, name)
	if err != nil {
		return Identity{Label: "未配置凭据"}
	}
	if spec.Type == "workbuddy-key" {
		id := "anonymous_" + tail(key, 8)
		return Identity{ID: id, Label: id, Tail: tail(key, 4)}
	}
	return Identity{ID: "key-" + tail(key, 4), Label: "key ····" + tail(key, 4), Tail: tail(key, 4)}
}

type Resolver func(ctx context.Context) (Headers, error)

func Build(p config.Provider) Resolver {
	return BuildAccount(p, nil)
}

// BuildAccount builds a resolver for one account in a provider's pool. A nil
// account means the provider's default credential.
func BuildAccount(p config.Provider, acct *config.Account) Resolver {
	spec, name := accountSpec(p, acct)
	switch spec.Type {
	case "", "none":
		return func(context.Context) (Headers, error) { return Headers{}, nil }

	case "bearer":
		return func(context.Context) (Headers, error) {
			token, err := secret(p, spec, name)
			if err != nil {
				return nil, err
			}
			return Headers{"Authorization": "Bearer " + token}, nil
		}

	case "header":
		return func(context.Context) (Headers, error) {
			token, err := secret(p, spec, name)
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
		//
		// The ChatGPT Codex backend requires the client's own identification
		// headers (they were captured from codex exec 0.167.0): account id,
		// originator, cli version, and a per-request session/thread id. Without
		// them the endpoint answers a bare "Bad Request".
		return func(context.Context) (Headers, error) {
			path := expandHome(firstNonEmpty(spec.File, "~/.codex/auth.json"))
			token, account, err := codexToken(path)
			if err != nil {
				return nil, err
			}
			session := newUUID()
			version := firstNonEmpty(os.Getenv("APX_CODEX_VERSION"), "0.167.0")
			return Headers{
				"Authorization":         "Bearer " + token,
				"chatgpt-account-id":    account,
				"originator":            "codex_cli_rs",
				"user-agent":            "codex_cli_rs/" + version + " (Windows 10.0.26200; x86_64)",
				"version":               version,
				"session-id":            session,
				"thread-id":             session,
				"x-client-request-id":   session,
				"x-codex-window-id":     session + ":0",
				"x-codex-beta-features": "remote_compaction_v2",
			}, nil
		}

	case "workbuddy-key":
		// WorkBuddy's public API takes the same key three ways, plus the
		// client identity its backend attributes usage to.
		return func(context.Context) (Headers, error) {
			key, err := secret(p, spec, name)
			if err != nil {
				return nil, err
			}
			return Headers(WorkBuddyKeyHeaders(key)), nil
		}

	case "workbuddy-oauth":
		return func(ctx context.Context) (Headers, error) {
			path := expandHome(firstNonEmpty(spec.File, "~/.apx2/auth/workbuddy.json"))
			t, err := EnsureWorkBuddyToken(ctx, path)
			if err != nil {
				return nil, err
			}
			return Headers(WorkBuddyHeaders(t)), nil
		}

	case "zcode-key":
		return func(context.Context) (Headers, error) {
			key, err := secret(p, spec, name)
			if err != nil {
				return nil, err
			}
			if p.Protocol == config.ProtocolAnthropic {
				return Headers{"x-api-key": key, "anthropic-version": "2023-06-01"}, nil
			}
			return Headers{"Authorization": "Bearer " + key, "x-api-key": key}, nil
		}

	case "zcode-config":
		// Read Zcode's own provider_config.json on every request. This is the
		// channel Zcode actually uses; no copy of the key is stored in apx.
		return func(context.Context) (Headers, error) {
			path := expandHome(firstNonEmpty(spec.File, "~/.zcode/v2/provider_config.json"))
			key, err := zcodeKey(path)
			if err != nil {
				return nil, err
			}
			if p.Protocol == config.ProtocolAnthropic {
				return Headers{"x-api-key": key, "anthropic-version": "2023-06-01"}, nil
			}
			return Headers{"Authorization": "Bearer " + key, "x-api-key": key}, nil
		}

	case "zcode-oauth":
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

// accountSpec merges an account's auth overrides over the provider default and
// returns the credential name ("provider#account" for pool entries).
func accountSpec(p config.Provider, acct *config.Account) (config.AuthConfig, string) {
	spec := p.Auth
	name := p.ID
	if acct == nil {
		return spec, name
	}
	name = p.ID + "#" + acct.ID
	if acct.Auth.Type != "" {
		spec.Type = acct.Auth.Type
	}
	if acct.Auth.Env != "" {
		spec.Env = acct.Auth.Env
	}
	if acct.Auth.File != "" {
		spec.File = acct.Auth.File
	}
	if acct.Auth.JSONPath != "" {
		spec.JSONPath = acct.Auth.JSONPath
	}
	if acct.Auth.Header != "" {
		spec.Header = acct.Auth.Header
	}
	if acct.Auth.Prefix != "" {
		spec.Prefix = acct.Auth.Prefix
	}
	return spec, name
}

// secret resolves a token from, in order: an env var, an explicit file+jsonPath,
// then ~/.apx2/credentials.json. Every step is read-only.
func secret(p config.Provider, spec config.AuthConfig, name string) (string, error) {
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
	names := []string{name}
	if name != p.ID {
		names = append(names, p.ID)
	}
	for _, n := range names {
		for _, suffix := range []string{".key", ".apiKey", ".accessToken"} {
			if v, err := readSecretFile(creds, n+suffix); err == nil && v != "" {
				return v, nil
			}
		}
	}
	return "", fmt.Errorf("未找到 %s 的凭据：请在控制台给该账号填写 Key，或设置环境变量 %s", name, firstNonEmpty(spec.Env, "APX_"+strings.ToUpper(p.ID)+"_KEY"))
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

// zcodeKey extracts the API key Zcode itself uses. Rules that point at magpie
// are skipped: apx reads Zcode's own relay, not another gateway.
func zcodeKey(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("读取 Zcode 配置失败：%w", err)
	}
	var doc struct {
		Config struct {
			ProviderConfigRules struct {
				ProviderRules []struct {
					ProviderID string `json:"providerId"`
					Config     struct {
						API struct {
							BaseURL string `json:"baseUrl"`
						} `json:"api"`
						Access struct {
							APIKey string `json:"apiKey"`
						} `json:"access"`
					} `json:"config"`
				} `json:"providerRules"`
			} `json:"providerConfigRules"`
		} `json:"config"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", err
	}
	for _, rule := range doc.Config.ProviderConfigRules.ProviderRules {
		if strings.Contains(rule.ProviderID, "magpie") {
			continue
		}
		if rule.Config.Access.APIKey != "" && rule.Config.API.BaseURL != "" {
			return strings.TrimSpace(rule.Config.Access.APIKey), nil
		}
	}
	return "", fmt.Errorf("%s 中没有可用的 Zcode provider key", path)
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

func codexAccount(path string) (id, email string, err error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}
	var doc struct {
		Tokens struct {
			AccountID string `json:"account_id"`
			IDToken   string `json:"id_token"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", "", err
	}
	id = doc.Tokens.AccountID
	if parts := strings.Split(doc.Tokens.IDToken, "."); len(parts) >= 2 {
		if payload, err := base64.RawURLEncoding.DecodeString(parts[1]); err == nil {
			var claims struct {
				Email             string `json:"email"`
				PreferredUsername string `json:"preferred_username"`
			}
			if json.Unmarshal(payload, &claims) == nil {
				email = firstNonEmpty(claims.Email, claims.PreferredUsername)
			}
		}
	}
	if id == "" && email == "" {
		return "", "", fmt.Errorf("%s 中没有账号信息", path)
	}
	return id, email, nil
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

func newUUID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}
