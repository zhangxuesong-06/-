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
	Account  *config.Account
	Model    string
}

// Key is the routing identity: one provider account. A provider without a pool
// uses its own ID.
func (t Target) Key() string {
	if t.Account != nil {
		return t.Provider.ID + "#" + t.Account.ID
	}
	return t.Provider.ID
}

func (t Target) AccountID() string {
	if t.Account == nil {
		return ""
	}
	return t.Account.ID
}

func (t Target) AccountLabel() string {
	if t.Account == nil {
		return ""
	}
	if t.Account.Name != "" {
		return t.Account.Name
	}
	return t.Account.ID
}

// Protocol is the wire protocol for this model, allowing one provider to mix
// chat and Anthropic models (WorkBuddy serves Claude on Messages).
func (t Target) Protocol() string {
	for _, m := range t.Provider.Models {
		if m.ID == t.Model && m.Protocol != "" {
			return m.Protocol
		}
	}
	return t.Provider.Protocol
}

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
			return Resolution{Requested: name, Provider: p.ID, Targets: expandProvider(p, model)}, nil
		}
		if g, ok := r.findGroupLocked(prefix); ok {
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
			if m.ID == name && !m.Disabled {
				targets = append(targets, expandProvider(p, name)...)
				break
			}
		}
	}
	if len(targets) > 0 {
		// A model supplied by more than one provider gets an automatic group, so
		// a bare model name already carries the group's strategy and failover.
		for _, g := range r.reg.GroupsWithAuto() {
			if g.Auto && g.Model == name {
				return Resolution{Requested: name, Group: g.ID, Targets: r.groupTargetsLocked(g, name)}, nil
			}
		}
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
		if len(p.Models) > 0 && !hasModel(p, model) {
			continue
		}
		targets = append(targets, expandProvider(p, model)...)
	}
	return targets
}

func expandProvider(p config.Provider, model string) []Target {
	if len(p.Accounts) == 0 {
		return []Target{{Provider: p, Model: model}}
	}
	out := make([]Target, 0, len(p.Accounts))
	for i := range p.Accounts {
		a := p.Accounts[i]
		if a.Disabled || a.ID == "" {
			continue
		}
		if len(a.Models) > 0 && !hasString(a.Models, model) {
			continue
		}
		out = append(out, Target{Provider: p, Account: &a, Model: model})
	}
	return out
}

func hasModel(p config.Provider, model string) bool {
	for _, m := range p.Models {
		if m.ID == model && !m.Disabled {
			return true
		}
	}
	return false
}

func hasString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func (r *Router) findGroupLocked(id string) (config.Group, bool) {
	for _, g := range r.reg.GroupsWithAuto() {
		if g.ID == id {
			return g, true
		}
	}
	return config.Group{}, false
}

func (r *Router) defaultModelLocked() string {
	for _, p := range r.reg.Providers {
		if p.Disabled {
			continue
		}
		for _, m := range p.Models {
			if !m.Disabled {
				return p.ID + "/" + m.ID
			}
		}
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
		if g, ok := r.findGroupLocked(res.Group); ok {
			switch strings.ToLower(g.Strategy) {
			case "rotate":
				if n := len(targets); n > 1 {
					off := r.rotate[g.ID] % n
					r.rotate[g.ID]++
					targets = append(targets[off:], targets[:off]...)
				}
			case "usage":
				sort.SliceStable(targets, func(i, j int) bool {
					return r.usage[targets[i].Key()] < r.usage[targets[j].Key()]
				})
			}
		}
	}

	var healthy, cooling []Target
	for _, t := range targets {
		if r.healthyLocked(t.Key()) {
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
	r.recordHealthLocked(provider, ok, latency, errText)
	if tokens > 0 {
		r.usage[provider] += int64(tokens)
	}
}

// RecordTarget records health for one provider account and keeps the provider
// aggregate in sync, so a failing account can cool down on its own.
func (r *Router) RecordTarget(t Target, ok bool, latency time.Duration, errText string, tokens int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.recordHealthLocked(t.Key(), ok, latency, errText)
	if t.Key() != t.Provider.ID {
		r.recordHealthLocked(t.Provider.ID, ok, latency, errText)
	}
	if tokens > 0 {
		r.usage[t.Key()] += int64(tokens)
	}
}

func (r *Router) recordHealthLocked(key string, ok bool, latency time.Duration, errText string) {
	h := r.health[key]
	if h == nil {
		h = &Health{}
		r.health[key] = h
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
