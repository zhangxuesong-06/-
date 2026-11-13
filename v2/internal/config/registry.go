package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Protocol names understood by the upstream client.
const (
	ProtocolOpenAIChat      = "openai-chat"
	ProtocolOpenAIResponses = "openai-responses"
	ProtocolAnthropic       = "anthropic"
)

type Account struct {
	ID       string     `json:"id"`
	Name     string     `json:"name,omitempty"`
	Models   []string   `json:"models,omitempty"` // empty = all provider models
	Auth     AuthConfig `json:"auth,omitempty"`
	Disabled bool       `json:"disabled,omitempty"`
}

type Provider struct {
	ID             string            `json:"id"`
	Name           string            `json:"name,omitempty"`
	Protocol       string            `json:"protocol"`
	BaseURL        string            `json:"baseUrl"`
	Proxy          string            `json:"proxy,omitempty"`
	TLSMax         string            `json:"tlsMax,omitempty"` // "1.2" forces TLS 1.2 for relays that break TLS 1.3
	Accounts       []Account         `json:"accounts,omitempty"`
	Auth           AuthConfig        `json:"auth"`
	Models         []Model           `json:"models,omitempty"`
	Discover       bool              `json:"discover,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
	Paths          map[string]string `json:"paths,omitempty"`
	TimeoutSeconds int               `json:"timeoutSeconds,omitempty"`
	Disabled       bool              `json:"disabled,omitempty"`
	Notes          string            `json:"notes,omitempty"`
	Source         string            `json:"source,omitempty"`
}

type Model struct {
	ID              string `json:"id"`
	Name            string `json:"name,omitempty"`
	Protocol        string `json:"protocol,omitempty"` // per-model override, e.g. Claude on Anthropic
	ContextWindow   int    `json:"contextWindow,omitempty"`
	MaxOutputTokens int    `json:"maxOutputTokens,omitempty"`
	Disabled        bool   `json:"disabled,omitempty"`
}

type AuthConfig struct {
	Type     string `json:"type"`
	Env      string `json:"env,omitempty"`
	File     string `json:"file,omitempty"`
	JSONPath string `json:"jsonPath,omitempty"`
	Header   string `json:"header,omitempty"`
	Prefix   string `json:"prefix,omitempty"`
}

type Group struct {
	ID        string   `json:"id"`
	Name      string   `json:"name,omitempty"`
	Strategy  string   `json:"strategy,omitempty"` // order | rotate | usage
	Providers []string `json:"providers"`
	Auto      bool     `json:"auto,omitempty"`
	Model     string   `json:"model,omitempty"`
}

type Registry struct {
	Providers []Provider `json:"providers"`
	Groups    []Group    `json:"groups,omitempty"`
}

func LoadRegistry() (Registry, error) {
	path := RegistryPath()
	var reg Registry
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return reg, nil
		}
		return reg, err
	}
	if err := json.Unmarshal(raw, &reg); err != nil {
		return reg, fmt.Errorf("parse %s: %w", path, err)
	}
	for i := range reg.Providers {
		normalizeProvider(&reg.Providers[i])
	}
	return reg, nil
}

func (r Registry) Save() error {
	path := RegistryPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(b, '\n'), 0o600)
}

func normalizeProvider(p *Provider) {
	if p.Protocol == "" {
		p.Protocol = ProtocolOpenAIChat
	}
	if p.Name == "" {
		p.Name = p.ID
	}
	p.BaseURL = strings.TrimRight(p.BaseURL, "/")
	seen := map[string]bool{}
	accounts := make([]Account, 0, len(p.Accounts))
	for _, a := range p.Accounts {
		a.ID = strings.TrimSpace(a.ID)
		if a.ID == "" || seen[a.ID] {
			continue
		}
		seen[a.ID] = true
		a.Models = dedupeList(a.Models)
		accounts = append(accounts, a)
	}
	p.Accounts = accounts
}

func (r Registry) Provider(id string) (Provider, bool) {
	for _, p := range r.Providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

func (r Registry) Group(id string) (Group, bool) {
	for _, g := range r.Groups {
		if g.ID == id {
			return g, true
		}
	}
	return Group{}, false
}

// GroupsWithAuto returns the user's groups plus generated groups for models
// supplied by two or more enabled providers. Generated groups are not persisted.
func (r Registry) GroupsWithAuto() []Group {
	out := append([]Group(nil), r.Groups...)
	userIDs := make(map[string]bool, len(r.Groups))
	for _, g := range r.Groups {
		userIDs[g.ID] = true
	}
	byModel := map[string][]string{}
	for _, p := range r.Providers {
		if p.Disabled {
			continue
		}
		for _, m := range p.Models {
			if m.Disabled || m.ID == "" {
				continue
			}
			if !containsString(byModel[m.ID], p.ID) {
				byModel[m.ID] = append(byModel[m.ID], p.ID)
			}
		}
	}
	var models []string
	for model, providers := range byModel {
		if len(providers) >= 2 {
			models = append(models, model)
		}
	}
	sort.Strings(models)
	for _, model := range models {
		id := AutoGroupID(model)
		if userIDs[id] {
			continue
		}
		out = append(out, Group{
			ID: id, Name: "同模型 · " + model, Strategy: "order",
			Providers: byModel[model], Auto: true, Model: model,
		})
	}
	return out
}

// AutoGroupID turns a model id into a stable, addressable group id.
func AutoGroupID(model string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(model) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	id := strings.Trim(b.String(), "-.")
	if id == "" {
		id = "model"
	}
	if len(id) > 48 {
		id = id[:48]
	}
	return "same-" + id
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func dedupeList(list []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(list))
	for _, s := range list {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func (p Provider) Account(id string) (Account, bool) {
	for _, a := range p.Accounts {
		if a.ID == id {
			return a, true
		}
	}
	return Account{}, false
}

// ModelIDs returns every model address the gateway can advertise, in the
// magpie style: provider/model for direct providers plus group/model for each
// group/model combination that exists on at least one group provider.
func (r Registry) ModelIDs() []string {
	seen := map[string]bool{}
	var out []string
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	for _, p := range r.Providers {
		if p.Disabled {
			continue
		}
		for _, m := range p.Models {
			if m.Disabled {
				continue
			}
			add(p.ID + "/" + m.ID)
		}
	}
	for _, g := range r.Groups {
		for _, pid := range g.Providers {
			p, ok := r.Provider(pid)
			if !ok || p.Disabled {
				continue
			}
			for _, m := range p.Models {
				if m.Disabled {
					continue
				}
				add(g.ID + "/" + m.ID)
			}
		}
	}
	return out
}

func (r Registry) FindModel(model string) (Provider, Model, bool) {
	for _, p := range r.Providers {
		if p.Disabled {
			continue
		}
		for _, m := range p.Models {
			if m.ID == model && !m.Disabled {
				return p, m, true
			}
		}
	}
	return Provider{}, Model{}, false
}
