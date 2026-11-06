// Package config owns both halves of the v2 configuration: the gateway
// settings (~/.apx2/config.json) and the provider registry
// (~/.apx2/providers.json). Keeping them in one package makes the CLI and the
// HTTP server agree on exactly one schema.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Listen         string            `json:"listen"`
	Token          string            `json:"token"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
	Limits         Limits            `json:"limits"`
	Aliases        map[string]string `json:"aliases"`
}

type Limits struct {
	MaxConcurrent  int         `json:"maxConcurrent"`
	QueueTimeoutMS int         `json:"queueTimeoutMs"`
	MaxInputChars  int         `json:"maxInputChars"`
	MaxTools       int         `json:"maxTools"`
	PriorityTools  []string    `json:"priorityTools"`
	TextToTool     *TextToTool `json:"textToTool"`
}

type TextToTool struct {
	Tool     string `json:"tool"`
	Argument string `json:"argument"`
	MaxChars int    `json:"maxChars"`
}

func Default() Config {
	return Config{
		Listen:         "127.0.0.1:8787",
		TimeoutSeconds: 180,
		Limits: Limits{
			MaxConcurrent:  4,
			QueueTimeoutMS: 30000,
			MaxInputChars:  24000,
			MaxTools:       8,
			PriorityTools:  []string{"pet_say", "pet_ask", "external_event_frame", "end_turn"},
			TextToTool:     &TextToTool{Tool: "pet_say", Argument: "script", MaxChars: 400},
		},
		Aliases: map[string]string{},
	}
}

func StateDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".apx2")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

func ConfigPath() string {
	if p := os.Getenv("APX2_CONFIG"); p != "" {
		return p
	}
	dir, err := StateDir()
	if err != nil {
		return "config.json"
	}
	return filepath.Join(dir, "config.json")
}

func RegistryPath() string {
	if p := os.Getenv("APX2_REGISTRY"); p != "" {
		return p
	}
	dir, err := StateDir()
	if err != nil {
		return "providers.json"
	}
	return filepath.Join(dir, "providers.json")
}

func CredentialsPath() string {
	if p := os.Getenv("APX2_CREDENTIALS"); p != "" {
		return p
	}
	dir, err := StateDir()
	if err != nil {
		return "credentials.json"
	}
	return filepath.Join(dir, "credentials.json")
}

func Load() (Config, error) {
	cfg := Default()
	path := ConfigPath()
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return cfg, fmt.Errorf("parse %s: %w", path, err)
		}
	case !os.IsNotExist(err):
		return cfg, err
	}
	if strings.TrimSpace(cfg.Listen) == "" {
		cfg.Listen = "127.0.0.1:8787"
	}
	if cfg.TimeoutSeconds <= 0 {
		cfg.TimeoutSeconds = 180
	}
	if cfg.Limits.MaxConcurrent <= 0 {
		cfg.Limits.MaxConcurrent = 4
	}
	if cfg.Limits.QueueTimeoutMS <= 0 {
		cfg.Limits.QueueTimeoutMS = 30000
	}
	if cfg.Aliases == nil {
		cfg.Aliases = map[string]string{}
	}
	if cfg.Token == "" {
		t, err := loadOrCreateToken()
		if err != nil {
			return cfg, err
		}
		cfg.Token = t
	}
	return cfg, nil
}

func (c Config) Save() error {
	path := ConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(b, '\n'), 0o600)
}

func loadOrCreateToken() (string, error) {
	dir, err := StateDir()
	if err != nil {
		return "", err
	}
	file := filepath.Join(dir, "token")
	if raw, err := os.ReadFile(file); err == nil {
		if s := strings.TrimSpace(string(raw)); s != "" {
			return s, nil
		}
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := "sk-local-" + hex.EncodeToString(buf)
	if err := writeFileAtomic(file, []byte(token+"\n"), 0o600); err != nil {
		return "", err
	}
	return token, nil
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func MaskToken(s string) string {
	if len(s) <= 10 {
		return s
	}
	return s[:6] + "…" + s[len(s)-4:]
}
