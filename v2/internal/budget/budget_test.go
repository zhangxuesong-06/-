package budget

import "testing"

func msg(role, content string) map[string]any {
	return map[string]any{"role": role, "content": content}
}

func TestSystemAlwaysKept(t *testing.T) {
	system := msg("system", string(make([]byte, 5000)))
	user := msg("user", "hi")
	res := Trim([]map[string]any{system, user}, nil, Limits{MaxInputChars: 100})
	if len(res.Messages) != 2 {
		t.Fatalf("messages = %d", len(res.Messages))
	}
	if res.Messages[0]["role"] != "system" {
		t.Fatalf("system dropped: %v", res.Messages)
	}
}

func TestKeepsNewestMessages(t *testing.T) {
	var in []map[string]any
	for i := 0; i < 20; i++ {
		in = append(in, msg("user", "message number "+string(rune('a'+i))))
	}
	res := Trim(in, nil, Limits{MaxInputChars: 120})
	if len(res.Messages) >= len(in) {
		t.Fatalf("nothing trimmed: %d", len(res.Messages))
	}
	last := res.Messages[len(res.Messages)-1]
	if last["content"] != in[len(in)-1]["content"] {
		t.Fatalf("last message not preserved: %v", last)
	}
	if len(res.Degraded) == 0 {
		t.Fatal("degradation not reported")
	}
}

func TestPriorityToolsSurviveCap(t *testing.T) {
	var tools []map[string]any
	for _, name := range []string{"a", "b", "pet_say", "c", "d"} {
		tools = append(tools, map[string]any{"type": "function", "function": map[string]any{"name": name}})
	}
	res := Trim([]map[string]any{msg("user", "hi")}, tools, Limits{
		MaxTools: 2, PriorityTools: []string{"pet_say"},
	})
	if len(res.Tools) != 2 {
		t.Fatalf("tools = %d", len(res.Tools))
	}
	found := false
	for _, tl := range res.Tools {
		if toolName(tl) == "pet_say" {
			found = true
		}
	}
	if !found {
		t.Fatalf("priority tool dropped: %v", res.Tools)
	}
}

func TestOrphanToolMessagesRemoved(t *testing.T) {
	in := []map[string]any{
		msg("user", "hi"),
		{"role": "tool", "tool_call_id": "missing", "content": "orphan"},
		msg("assistant", "ok"),
	}
	res := Trim(in, nil, Limits{MaxInputChars: 100})
	for _, m := range res.Messages {
		if m["role"] == "tool" {
			t.Fatalf("orphan tool message kept: %v", res.Messages)
		}
	}
}

func TestNoLimitsIsIdentity(t *testing.T) {
	in := []map[string]any{msg("user", "hi"), msg("assistant", "yo")}
	res := Trim(in, nil, Limits{})
	if len(res.Messages) != 2 {
		t.Fatalf("messages = %v", res.Messages)
	}
}
