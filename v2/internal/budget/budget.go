package budget

import (
	"encoding/json"
	"fmt"
)

// Limits is the subset the budget needs. Zero means "do not trim".
type Limits struct {
	MaxInputChars int
	MaxTools      int
	PriorityTools []string
}

// Result carries the trimmed payload and a human-readable degradation list.
type Result struct {
	Messages []map[string]any
	Tools    []map[string]any
	Degraded []string
}

func size(v any) int {
	b, err := json.Marshal(v)
	if err != nil {
		return 0
	}
	return len(b)
}

func isSystem(m map[string]any) bool {
	role, _ := m["role"].(string)
	return role == "system" || role == "developer"
}

func stringField(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return v
}

// Trim keeps system messages, the most recent messages, and a bounded tool set.
//
// The previous prototype treated system + tools + messages as one character
// budget. That broke Coopanion: its system prompt alone is ~18k chars, so tools
// (including pet_say) were dropped and the pet window had nothing to execute.
// Here MaxInputChars applies to non-system messages only; tools are capped by
// MaxTools/priorityTools, and system is always kept.
func Trim(messages []map[string]any, tools []map[string]any, limits Limits) Result {
	if limits.MaxInputChars <= 0 && limits.MaxTools <= 0 {
		return Result{Messages: messages, Tools: tools}
	}

	var system, rest []map[string]any
	for _, m := range messages {
		if isSystem(m) {
			system = append(system, m)
		} else {
			rest = append(rest, m)
		}
	}

	var degraded []string

	// 1) Tools: priority tools first, then tools referenced by recent messages,
	// then original order. MaxTools=0 means keep all.
	toolCap := limits.MaxTools
	if toolCap > 0 && len(tools) > toolCap {
		usedNames := map[string]bool{}
		for _, m := range rest {
			calls, _ := m["tool_calls"].([]any)
			for _, c := range calls {
				cm, _ := c.(map[string]any)
				fn, _ := cm["function"].(map[string]any)
				if name, _ := fn["name"].(string); name != "" {
					usedNames[name] = true
				}
			}
		}
		priority := map[string]bool{}
		for _, n := range limits.PriorityTools {
			priority[n] = true
		}
		var picked, referenced, others []map[string]any
		for _, t := range tools {
			name := toolName(t)
			switch {
			case priority[name]:
				picked = append(picked, t)
			case usedNames[name]:
				referenced = append(referenced, t)
			default:
				others = append(others, t)
			}
		}
		all := append(append(picked, referenced...), others...)
		if len(all) > toolCap {
			degraded = append(degraded, fmt.Sprintf("tools_trimmed=%d", len(tools)-toolCap))
			all = all[:toolCap]
		}
		tools = all
	}

	// 2) Messages: keep the newest ones within MaxInputChars. The last message
	// is always kept even when it alone exceeds the budget.
	if limits.MaxInputChars > 0 && len(rest) > 0 {
		used := 0
		kept := make([]map[string]any, 0, len(rest))
		for i := len(rest) - 1; i >= 0; i-- {
			m := rest[i]
			s := size(m)
			if len(kept) == 0 {
				kept = append(kept, m)
				used += s
				continue
			}
			if used+s > limits.MaxInputChars {
				break
			}
			kept = append(kept, m)
			used += s
		}
		for i, j := 0, len(kept)-1; i < j; i, j = i+1, j-1 {
			kept[i], kept[j] = kept[j], kept[i]
		}
		if dropped := len(rest) - len(kept); dropped > 0 {
			degraded = append(degraded, fmt.Sprintf("messages_trimmed=%d", dropped))
		}
		rest = kept
	}

	// 3) Remove orphan tool messages / tool_calls whose pair was cut off.
	callIDs := map[string]bool{}
	for _, m := range rest {
		calls, _ := m["tool_calls"].([]any)
		for _, c := range calls {
			cm, _ := c.(map[string]any)
			if id, _ := cm["id"].(string); id != "" {
				callIDs[id] = true
			}
		}
	}
	outputIDs := map[string]bool{}
	filtered := rest[:0]
	for _, m := range rest {
		if stringField(m, "role") == "tool" {
			id := stringField(m, "tool_call_id")
			if !callIDs[id] {
				continue
			}
			outputIDs[id] = true
		}
		filtered = append(filtered, m)
	}
	cleaned := filtered[:0]
	for _, m := range filtered {
		calls, _ := m["tool_calls"].([]any)
		if stringField(m, "role") == "assistant" && len(calls) > 0 {
			hasOutput := false
			for _, c := range calls {
				cm, _ := c.(map[string]any)
				if id, _ := cm["id"].(string); outputIDs[id] {
					hasOutput = true
					break
				}
			}
			content, _ := m["content"].(string)
			if !hasOutput && content == "" {
				continue
			}
		}
		cleaned = append(cleaned, m)
	}
	if dropped := len(rest) - len(cleaned); dropped > 0 {
		degraded = append(degraded, fmt.Sprintf("tool_groups_dropped=%d", dropped))
	}

	out := make([]map[string]any, 0, len(system)+len(cleaned))
	out = append(out, system...)
	out = append(out, cleaned...)
	return Result{Messages: out, Tools: tools, Degraded: degraded}
}

func toolName(t map[string]any) string {
	if fn, ok := t["function"].(map[string]any); ok {
		if name, _ := fn["name"].(string); name != "" {
			return name
		}
	}
	if name, _ := t["name"].(string); name != "" {
		return name
	}
	return ""
}
