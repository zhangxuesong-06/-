// Package router resolves a downstream model name to an ordered list of
// upstream (provider, model) targets, mirroring magpie's provider/model and
// routing-group addressing.
package router

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"apx2/internal/config"
)

type Target struct {
	Provider config.Provider
	Model    string
}

func (t Target) Key() string { return t.Provider.ID + "/" + t.Model }

type Resolution struct {
	Requested string
	Group     string
	Provider  string
	Targets   []Target
}

type Health struct {
	OK          bool      `json:"ok"`
	Failures    int       `json:"failures"`
	LastError   string    `json:"lastError,omitempty"`
	LastLatency int64     `json:"lastLatencyMs,omitempty"`
	LastSeen    time.Time `json:"lastSeen,omitempty"`
	CoolingTill time.Time `json:"-"`
}

type Router struct {
	mu      sync.Mutex
	reg     config.Registry
	aliases map[string]string
	rotate  map[string]int
	health  map[string]*Health
	usage   map[string]int64
}

func New(reg config.Registry, aliases map[string]string) *Router {
	return &Router{
		reg: reg, aliases: aliases,
		rotate: map[string]int{}, health: map[string]*Health{}, usage: map[string]int64{},
	}
}

func (r *Router) Registry() config.Registry {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reg
}

func (r *Router) Reload(reg config.Registry, aliases map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reg = reg
	r.aliases = aliases
}

// Resolve accepts:
//
//	provider/model       e.g. ollama/qwen2.5:0.5b
//	group/model          e.g. auto/deepseek-v4.1-flash
//	model                e.g. qwen2.5:0.5b (unique across providers)
func (r *Router) Resolve(name string) (Resolution, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.resolveLocked(name, true)
}

func (r *Router) resolveLocked(name string, allowAlias bool) (Resolution, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = r.defaultModelLocked()
	}
	if name == "" {
		return Resolution{}, fmt.Errorf("没有可用模型：请运行 `apx init` 或检查 providers.json")
	}
	if allowAlias {
		if mapped, ok := r.aliases[name]; ok {
			res, err := r.resolveLocked(mapped, false)
			if err == nil {
				res.Requested = name
				return res, nil
			}
		}
	}

	if i := strings.Index(name, "/"); i > 0 {
		prefix, model := name[:i], name[i+1:]
		if p, ok := r.reg.Provider(prefix); ok && !p.Disabled {
			return Resolution{Requested: name, Provider: p.ID, Targets: []Target{{Provider: p, Model: model}}}, nil
		}
		if g, ok := r.reg.Group(prefix); ok {
			targets := r.groupTargetsLocked(g, model)
			if len(targets) == 0 {
				return Resolution{}, fmt.Errorf("路由组 %s 中没有模型 %s", prefix, model)
			}
			return Resolution{Requested: name, Group: g.ID, Targets: targets}, nil
		}
	}

	// Unique bare model name.
	var targets []Target
	for _, p := range r.reg.Providers {
		if p.Disabled {
			continue
		}
		for _, m := range p.Models {
			if m.ID == name {
				targets = append(targets, Target{Provider: p, Model: name})
				break
			}
		}
	}
	if len(targets) > 0 {
		return Resolution{Requested: name, Targets: targets}, nil
	}
	return Resolution{}, fmt.Errorf("未找到模型 %q；可用：%s", name, strings.Join(shortList(r.reg.ModelIDs(), 12), ", "))
}

func (r *Router) groupTargetsLocked(g config.Group, model string) []Target {
	var targets []Target
	for _, pid := range g.Providers {
		p, ok := r.reg.Provider(pid)
		if !ok || p.Disabled {
			continue
		}
		if len(p.Models) > 0 && !p.Discover && !hasModel(p, model) {
			continue
		}
		targets = append(targets, Target{Provider: p, Model: model})
	}
	return targets
}

func hasModel(p config.Provider, model string) bool {
	for _, m := range p.Models {
		if m.ID == model {
			return true
		}
	}
	return false
}

func (r *Router) defaultModelLocked() string {
	for _, p := range r.reg.Providers {
		if p.Disabled || len(p.Models) == 0 {
			continue
		}
		return p.ID + "/" + p.Models[0].ID
	}
	models := r.reg.ModelIDs()
	if len(models) > 0 {
		return models[0]
	}
	return ""
}

// Order applies the group strategy and moves cooling-down providers to the back
// so a dead upstream costs one attempt, not the whole request.
func (r *Router) Order(res Resolution) []Target {
	r.mu.Lock()
	defer r.mu.Unlock()

	targets := append([]Target(nil), res.Targets...)
	if res.Group != "" {
		if g, ok := r.reg.Group(res.Group); ok {
			switch strings.ToLower(g.Strategy) {
			case "rotate":
				if n := len(targets); n > 1 {
					off := r.rotate[g.ID] % n
					r.rotate[g.ID]++
					targets = append(targets[off:], targets[:off]...)
				}
			case "usage":
				sort.SliceStable(targets, func(i, j int) bool {
					return r.usage[targets[i].Provider.ID] < r.usage[targets[j].Provider.ID]
				})
			}
		}
	}

	var healthy, cooling []Target
	for _, t := range targets {
		if r.healthyLocked(t.Provider.ID) {
			healthy = append(healthy, t)
		} else {
			cooling = append(cooling, t)
		}
	}
	return append(healthy, cooling...)
}

func (r *Router) healthyLocked(provider string) bool {
	h := r.health[provider]
	if h == nil {
		return true
	}
	return h.Failures < 3 || time.Now().After(h.CoolingTill)
}

func (r *Router) Record(provider string, ok bool, latency time.Duration, errText string, tokens int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := r.health[provider]
	if h == nil {
		h = &Health{}
		r.health[provider] = h
	}
	h.LastSeen = time.Now()
	h.LastLatency = latency.Milliseconds()
	h.OK = ok
	if ok {
		h.Failures = 0
		h.LastError = ""
		h.CoolingTill = time.Time{}
	} else {
		h.Failures++
		h.LastError = errText
		h.CoolingTill = time.Now().Add(time.Duration(h.Failures) * 15 * time.Second)
	}
	if tokens > 0 {
		r.usage[provider] += int64(tokens)
	}
}

func (r *Router) HealthSnapshot() map[string]Health {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]Health, len(r.health))
	for k, v := range r.health {
		out[k] = *v
	}
	return out
}

func shortList(items []string, n int) []string {
	if len(items) > n {
		return append(append([]string{}, items[:n]...), "…")
	}
	return items
}
