package router

import (
	"reflect"
	"testing"
	"time"

	"apx2/internal/config"
)

func reg() config.Registry {
	return config.Registry{
		Providers: []config.Provider{
			{ID: "wb", Protocol: config.ProtocolOpenAIChat, BaseURL: "http://wb", Models: []config.Model{{ID: "deepseek"}, {ID: "glm"}, {ID: "shared"}}},
			{ID: "ollama", Protocol: config.ProtocolOpenAIChat, BaseURL: "http://ol", Models: []config.Model{{ID: "qwen"}, {ID: "shared"}}},
			{ID: "codex", Protocol: config.ProtocolOpenAIResponses, BaseURL: "http://cx", Models: []config.Model{{ID: "gpt"}}},
		},
		Groups: []config.Group{
			{ID: "auto", Strategy: "order", Providers: []string{"wb", "codex", "ollama"}},
			{ID: "rota", Strategy: "rotate", Providers: []string{"wb", "ollama"}},
		},
	}
}

func TestResolveQualified(t *testing.T) {
	r := New(reg(), nil)
	res, err := r.Resolve("ollama/qwen")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Targets) != 1 || res.Targets[0].Provider.ID != "ollama" || res.Targets[0].Model != "qwen" {
		t.Fatalf("res = %+v", res)
	}
}

func TestResolveGroupSkipsProvidersWithoutModel(t *testing.T) {
	r := New(reg(), nil)
	res, err := r.Resolve("auto/glm")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Targets) != 1 || res.Targets[0].Provider.ID != "wb" {
		t.Fatalf("targets = %+v", res.Targets)
	}
	// qwen exists only on ollama, which is last in the group.
	res, err = r.Resolve("auto/qwen")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Targets) != 1 || res.Targets[0].Provider.ID != "ollama" {
		t.Fatalf("targets = %+v", res.Targets)
	}
}

func TestResolveBareAndAlias(t *testing.T) {
	r := New(reg(), map[string]string{"fast": "ollama/qwen"})
	res, err := r.Resolve("gpt")
	if err != nil {
		t.Fatal(err)
	}
	if res.Targets[0].Provider.ID != "codex" {
		t.Fatalf("bare resolve = %+v", res)
	}
	res, err = r.Resolve("fast")
	if err != nil {
		t.Fatal(err)
	}
	if res.Requested != "fast" || res.Targets[0].Provider.ID != "ollama" {
		t.Fatalf("alias resolve = %+v", res)
	}
}

func TestResolveUnknown(t *testing.T) {
	r := New(reg(), nil)
	if _, err := r.Resolve("nope"); err == nil {
		t.Fatal("expected error")
	}
}

func TestRotate(t *testing.T) {
	r := New(reg(), nil)
	first, _ := r.Resolve("rota/shared")
	var order []string
	for i := 0; i < 4; i++ {
		for _, target := range r.Order(first) {
			order = append(order, target.Provider.ID)
		}
	}
	// Each call returns 2 targets; the first one should alternate.
	if order[0] != "wb" || order[2] != "ollama" || order[4] != "wb" {
		t.Fatalf("rotate order = %v", order)
	}
}

func TestUsageOrder(t *testing.T) {
	r := New(config.Registry{
		Providers: []config.Provider{
			{ID: "a", Models: []config.Model{{ID: "m"}}},
			{ID: "b", Models: []config.Model{{ID: "m"}}},
		},
		Groups: []config.Group{{ID: "g", Strategy: "usage", Providers: []string{"a", "b"}}},
	}, nil)
	r.Record("a", true, time.Millisecond, "", 100)
	r.Record("b", true, time.Millisecond, "", 1)
	res, _ := r.Resolve("g/m")
	got := r.Order(res)
	if len(got) != 2 || got[0].Provider.ID != "b" {
		t.Fatalf("usage order = %+v", got)
	}
}

func TestHealthDemotes(t *testing.T) {
	r := New(config.Registry{
		Providers: []config.Provider{
			{ID: "bad", Models: []config.Model{{ID: "m"}}},
			{ID: "good", Models: []config.Model{{ID: "m"}}},
		},
		Groups: []config.Group{{ID: "g", Providers: []string{"bad", "good"}}},
	}, nil)
	for i := 0; i < 3; i++ {
		r.Record("bad", false, time.Millisecond, "boom", 0)
	}
	res, _ := r.Resolve("g/m")
	got := r.Order(res)
	if got[0].Provider.ID != "good" {
		names := make([]string, 0, len(got))
		for _, t := range got {
			names = append(names, t.Provider.ID)
		}
		t.Fatalf("order = %v", names)
	}
}

func TestGroupSkipsDiscoveredProviderWithoutModel(t *testing.T) {
	r := New(config.Registry{
		Providers: []config.Provider{
			{ID: "disc", Models: []config.Model{{ID: "a"}}, Discover: true},
			{ID: "local", Models: []config.Model{{ID: "b"}}},
		},
		Groups: []config.Group{{ID: "g", Providers: []string{"disc", "local"}}},
	}, nil)
	res, err := r.Resolve("g/b")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Targets) != 1 || res.Targets[0].Provider.ID != "local" {
		t.Fatalf("targets = %+v", res.Targets)
	}
}

func TestProviderAccountPoolExpands(t *testing.T) {
	r := New(config.Registry{
		Providers: []config.Provider{{
			ID: "pool", Models: []config.Model{{ID: "m"}},
			Accounts: []config.Account{
				{ID: "a1"}, {ID: "a2", Disabled: true}, {ID: "a3"},
			},
		}},
	}, nil)
	res, err := r.Resolve("pool/m")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Targets) != 2 {
		t.Fatalf("targets = %+v", res.Targets)
	}
	if res.Targets[0].AccountID() != "a1" || res.Targets[1].AccountID() != "a3" {
		t.Fatalf("account targets = %+v", res.Targets)
	}
	if res.Targets[0].Key() != "pool#a1" {
		t.Fatalf("key = %s", res.Targets[0].Key())
	}
}

func TestRotateAcrossAccounts(t *testing.T) {
	r := New(config.Registry{
		Providers: []config.Provider{{
			ID: "pool", Models: []config.Model{{ID: "m"}},
			Accounts: []config.Account{{ID: "a1"}, {ID: "a2"}},
		}},
		Groups: []config.Group{{ID: "g", Strategy: "rotate", Providers: []string{"pool"}}},
	}, nil)
	res, _ := r.Resolve("g/m")
	var seen []string
	for i := 0; i < 4; i++ {
		order := r.Order(res)
		seen = append(seen, order[0].AccountID())
	}
	if len(seen) != 4 || seen[0] != "a1" || seen[1] != "a2" || seen[2] != "a1" {
		t.Fatalf("rotate = %v", seen)
	}
}

func TestModelProtocolOverride(t *testing.T) {
	r := New(config.Registry{
		Providers: []config.Provider{{
			ID: "wb", Protocol: config.ProtocolOpenAIChat,
			Models: []config.Model{
				{ID: "glm"},
				{ID: "claude-opus-5.5", Protocol: config.ProtocolAnthropic},
			},
		}},
	}, nil)
	res, err := r.Resolve("wb/claude-opus-5.5")
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Targets[0].Protocol(); got != config.ProtocolAnthropic {
		t.Fatalf("protocol = %s", got)
	}
	res, _ = r.Resolve("wb/glm")
	if got := res.Targets[0].Protocol(); got != config.ProtocolOpenAIChat {
		t.Fatalf("protocol = %s", got)
	}
}

func TestAutoGroupForSharedModel(t *testing.T) {
	reg := config.Registry{Providers: []config.Provider{
		{ID: "a", Models: []config.Model{{ID: "m"}}},
		{ID: "b", Models: []config.Model{{ID: "m"}}},
		{ID: "c", Models: []config.Model{{ID: "only"}}},
	}}
	r := New(reg, nil)
	res, err := r.Resolve("m")
	if err != nil {
		t.Fatal(err)
	}
	want := config.AutoGroupID("m")
	if res.Group != want {
		t.Fatalf("group = %q want %q", res.Group, want)
	}
	if len(res.Targets) != 2 {
		t.Fatalf("targets = %+v", res.Targets)
	}
	// The generated group is addressable too.
	res, err = r.Resolve(want + "/m")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Targets) != 2 {
		t.Fatalf("group targets = %+v", res.Targets)
	}
}

func TestAccountModelScope(t *testing.T) {
	r := New(config.Registry{Providers: []config.Provider{{
		ID: "p", Models: []config.Model{{ID: "m"}, {ID: "x"}},
		Accounts: []config.Account{
			{ID: "a1", Models: []string{"m"}},
			{ID: "a2", Models: []string{"x"}},
			{ID: "a3"}, // all models
		},
	}}}, nil)
	res, err := r.Resolve("p/m")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, tgt := range res.Targets {
		ids = append(ids, tgt.AccountID())
	}
	if len(ids) != 2 || ids[0] != "a1" || ids[1] != "a3" {
		t.Fatalf("accounts for m = %v", ids)
	}
	res, _ = r.Resolve("p/x")
	ids = nil
	for _, tgt := range res.Targets {
		ids = append(ids, tgt.AccountID())
	}
	if len(ids) != 2 || ids[0] != "a2" || ids[1] != "a3" {
		t.Fatalf("accounts for x = %v", ids)
	}
}

func TestModelIDs(t *testing.T) {
	ids := reg().ModelIDs()
	want := []string{
		"wb/deepseek", "wb/glm", "wb/shared", "ollama/qwen", "ollama/shared", "codex/gpt",
		"auto/deepseek", "auto/glm", "auto/shared", "auto/gpt", "auto/qwen",
		"rota/deepseek", "rota/glm", "rota/shared", "rota/qwen",
	}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids = %v", ids)
	}
}
