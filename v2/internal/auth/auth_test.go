package auth

import (
	"context"
	"os"
	"path/filepath"
	"testing"

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
