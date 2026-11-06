package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Protocol names understood by the upstream client.
const (
	ProtocolOpenAIChat      = "openai-chat"
	ProtocolOpenAIResponses = "openai-responses"
	ProtocolAnthropic       = "anthropic"
)

type Provider struct {
	ID             string            `json:"id"`
	Name           string            `json:"name,omitempty"`
	Protocol       string            `json:"protocol"`
	BaseURL        string            `json:"baseUrl"`
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
	ContextWindow   int    `json:"contextWindow,omitempty"`
	MaxOutputTokens int    `json:"maxOutputTokens,omitempty"`
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
				add(g.ID + "/" + m.ID)
			}
		}
	}
	return out
}

func (r Registry) FindModel(model string) (Provider, Model, bool) {
	for _, p := range r.Providers {
		for _, m := range p.Models {
			if m.ID == model {
				return p, m, true
			}
		}
	}
	return Provider{}, Model{}, false
}
