package auth

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"apx2/internal/config"
)

func resolve(t *testing.T, p config.Provider) Headers {
	t.Helper()
	h, err := Build(p)(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestBearerFromEnv(t *testing.T) {
	t.Setenv("APX_TEST_TOKEN", "abc123")
	h := resolve(t, config.Provider{ID: "x", Auth: config.AuthConfig{Type: "bearer", Env: "APX_TEST_TOKEN"}})
	if h["Authorization"] != "Bearer abc123" {
		t.Fatalf("headers = %v", h)
	}
}

func TestFileJSONPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")
	_ = os.WriteFile(path, []byte(`{"tokens":{"access_token":"tok","account_id":"acc"}}`), 0o600)
	h := resolve(t, config.Provider{ID: "codex", Auth: config.AuthConfig{
		Type: "codex-oauth", File: path,
	}})
	if h["Authorization"] != "Bearer tok" || h["chatgpt-account-id"] != "acc" {
		t.Fatalf("headers = %v", h)
	}
}

func TestWorkBuddyKeyHeaders(t *testing.T) {
	t.Setenv("APX_WORKBUDDY_KEY", "ck-12345678")
	h := resolve(t, config.Provider{ID: "workbuddy", Auth: config.AuthConfig{
		Type: "workbuddy-key", Env: "APX_WORKBUDDY_KEY",
	}})
	if h["X-API-Key"] != "ck-12345678" || h["Authorization"] != "Bearer ck-12345678" {
		t.Fatalf("headers = %v", h)
	}
	if h["X-User-Id"] != "anonymous_12345678" {
		t.Fatalf("user id = %v", h["X-User-Id"])
	}
}

func TestZcodeAnthropic(t *testing.T) {
	t.Setenv("APX_ZCODE_KEY", "glm-key")
	h := resolve(t, config.Provider{ID: "zcode", Protocol: config.ProtocolAnthropic, Auth: config.AuthConfig{
		Type: "zcode-key", Env: "APX_ZCODE_KEY",
	}})
	if h["x-api-key"] != "glm-key" || h["anthropic-version"] == "" {
		t.Fatalf("headers = %v", h)
	}
}

func TestMissingSecret(t *testing.T) {
	t.Setenv("APX2_CREDENTIALS", filepath.Join(t.TempDir(), "missing.json"))
	_, err := Build(config.Provider{ID: "nope", Auth: config.AuthConfig{Type: "bearer", Env: "APX_NO_SUCH_VAR"}})(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestZcodeConfigSkipsMagpie(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "provider_config.json")
	raw := `{"config":{"providerConfigRules":{"providerRules":[
		{"providerId":"magpie","config":{"api":{"baseUrl":"http://127.0.0.1:3425"},"access":{"apiKey":"magpie-key"}}},
		{"providerId":"bigmodel-api","config":{"api":{"baseUrl":"https://relay.example/v1"},"access":{"apiKey":"relay-key"}}}
	]}}}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	h := resolve(t, config.Provider{
		ID: "zcode", Protocol: config.ProtocolOpenAIChat,
		Auth: config.AuthConfig{Type: "zcode-config", File: path},
	})
	if h["Authorization"] != "Bearer relay-key" || h["x-api-key"] != "relay-key" {
		t.Fatalf("headers = %v", h)
	}
}

func TestDescribeWorkBuddy(t *testing.T) {
	t.Setenv("APX_WORKBUDDY_KEY", "ck-12345678")
	id := Describe(config.Provider{ID: "workbuddy", Auth: config.AuthConfig{
		Type: "workbuddy-key", Env: "APX_WORKBUDDY_KEY",
	}})
	if id.Label != "anonymous_12345678" || id.Tail != "5678" {
		t.Fatalf("identity = %+v", id)
	}
}

func TestDescribeCodexEmail(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"user@example.com"}`))
	raw := `{"tokens":{"account_id":"7ed9c233-6745-4c21-b46e-902cdf6a149f","id_token":"x.` + payload + `.y"}}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	id := Describe(config.Provider{ID: "codex", Auth: config.AuthConfig{Type: "codex-oauth", File: path}})
	if id.Label != "user@example.com" || id.ID == "" {
		t.Fatalf("identity = %+v", id)
	}
}

func TestAccountKeyAndIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv("APX2_CREDENTIALS", path)
	if err := SetSecret("relay#a1", "key", "sk-1111"); err != nil {
		t.Fatal(err)
	}
	p := config.Provider{ID: "relay", Auth: config.AuthConfig{Type: "bearer"}}
	acct := config.Account{ID: "a1", Name: "主号"}
	headers, err := BuildAccount(p, &acct)(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if headers["Authorization"] != "Bearer sk-1111" {
		t.Fatalf("headers = %v", headers)
	}
	id := DescribeAccount(p, &acct)
	if id.Label != "主号 · key ····1111" || id.ID != "key-1111" {
		t.Fatalf("identity = %+v", id)
	}
}

func TestWorkBuddyKeyClientHeaders(t *testing.T) {
	h := WorkBuddyKeyHeaders("ck-12345678")
	if h["X-API-Key"] != "ck-12345678" || h["X-User-Id"] != "anonymous_12345678" {
		t.Fatalf("headers = %v", h)
	}
	if !strings.HasPrefix(h["User-Agent"], "WorkBuddy/5.9.3") {
		t.Fatalf("ua = %q", h["User-Agent"])
	}
	if h["X-Product"] != "SaaS" || h["X-IDE-Type"] != "WorkBuddy" {
		t.Fatalf("client headers = %v", h)
	}
}

func TestEnsureWorkBuddyTokenFresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workbuddy.json")
	tok := WorkBuddyToken{Access: "a", Refresh: "r", Expires: time.Now().Add(time.Hour).UnixMilli(), UID: "u1"}
	if err := SaveWorkBuddyToken(path, tok); err != nil {
		t.Fatal(err)
	}
	got, err := EnsureWorkBuddyToken(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Access != "a" || got.UID != "u1" {
		t.Fatalf("token = %+v", got)
	}
	id := WorkBuddyTokenIdentity(got)
	if id.ID != "u1" || id.Label == "" {
		t.Fatalf("identity = %+v", id)
	}
}

func TestSetSecretRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv("APX2_CREDENTIALS", path)
	if err := SetSecret("workbuddy", "key", "ck-abcdefgh"); err != nil {
		t.Fatal(err)
	}
	h := resolve(t, config.Provider{ID: "workbuddy", Auth: config.AuthConfig{Type: "workbuddy-key"}})
	if h["X-API-Key"] != "ck-abcdefgh" {
		t.Fatalf("headers = %v", h)
	}
}
