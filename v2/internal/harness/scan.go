// Package harness inspects the other agent apps installed on this machine and
// reports which model channel, if any, apx can borrow directly — without magpie
// and without touching the owner's encrypted stores.
package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"apx2/internal/config"
)

type Finding struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Kind      string           `json:"kind"`
	Available bool             `json:"available"`
	Healthy   *bool            `json:"healthy,omitempty"`
	Detail    string           `json:"detail"`
	Note      string           `json:"note,omitempty"`
	Models    []string         `json:"models,omitempty"`
	Provider  *config.Provider `json:"provider,omitempty"`
}

type Report struct {
	At       string    `json:"at"`
	Findings []Finding `json:"findings"`
}

func Scan(ctx context.Context) Report {
	rep := Report{At: time.Now().Format(time.RFC3339)}
	rep.Findings = append(rep.Findings, scanLocalOpenAI(ctx)...)
	rep.Findings = append(rep.Findings, scanCodex(ctx))
	rep.Findings = append(rep.Findings, scanZcode())
	rep.Findings = append(rep.Findings, scanWorkBuddy())
	rep.Findings = append(rep.Findings, scanOpenCode())
	rep.Findings = append(rep.Findings, scanDSH())
	return rep
}

func scanLocalOpenAI(ctx context.Context) []Finding {
	var out []Finding
	client := &http.Client{Timeout: 2 * time.Second}
	for _, port := range []int{11434, 1234, 8080, 8000} {
		base := fmt.Sprintf("http://127.0.0.1:%d", port)
		models, err := listLocalModels(ctx, client, base)
		if err != nil || len(models) == 0 {
			continue
		}
		healthy := true
		name := "本机 OpenAI 兼容服务"
		id := fmt.Sprintf("local-%d", port)
		if port == 11434 {
			name = "Ollama"
			id = "ollama"
		}
		out = append(out, Finding{
			ID: id, Name: name, Kind: "local-service", Available: true, Healthy: &healthy,
			Detail: fmt.Sprintf("%s，%d 个模型", base, len(models)), Models: models,
			Provider: &config.Provider{
				ID: id, Name: name, Protocol: config.ProtocolOpenAIChat, BaseURL: base,
				Auth: config.AuthConfig{Type: "none"}, Discover: true, Source: "scan",
			},
		})
	}
	return out
}

func listLocalModels(ctx context.Context, client *http.Client, base string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s", resp.Status)
	}
	var doc struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, err
	}
	var out []string
	for _, m := range doc.Data {
		if m.ID != "" {
			out = append(out, m.ID)
		}
	}
	return out, nil
}

func scanCodex(ctx context.Context) Finding {
	f := Finding{ID: "codex", Name: "Codex (ChatGPT OAuth)", Kind: "harness"}
	path := expandHome("~/.codex/auth.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		f.Detail = "未找到 " + path
		return f
	}
	var doc struct {
		AuthMode string `json:"auth_mode"`
		Tokens   struct {
			AccessToken string `json:"access_token"`
			AccountID   string `json:"account_id"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Tokens.AccessToken == "" {
		f.Detail = "auth.json 中没有可读的 ChatGPT OAuth token"
		return f
	}
	f.Available = true
	f.Detail = fmt.Sprintf("明文 OAuth token（account %s）", tail(doc.Tokens.AccountID, 6))

	// Is the official endpoint reachable from this machine right now?
	healthy := false
	client := &http.Client{Timeout: 5 * time.Second}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://chatgpt.com/backend-api/codex/models", nil)
	req.Header.Set("Authorization", "Bearer "+doc.Tokens.AccessToken)
	req.Header.Set("chatgpt-account-id", doc.Tokens.AccountID)
	if resp, err := client.Do(req); err == nil {
		healthy = resp.StatusCode < 500
		resp.Body.Close()
		f.Note = fmt.Sprintf("chatgpt.com 返回 %s", resp.Status)
	} else {
		f.Note = "本机无法连接 chatgpt.com：" + err.Error()
	}
	f.Healthy = &healthy

	model := readCodexModel()
	models := []string{}
	if model != "" {
		models = append(models, model)
	}
	for _, m := range []string{"gpt-6.1-sol", "gpt-6-astra", "gpt-5.4-codex"} {
		if m != model {
			models = append(models, m)
		}
	}
	f.Models = models
	list := make([]config.Model, 0, len(models))
	for _, m := range models {
		list = append(list, config.Model{ID: m})
	}
	f.Provider = &config.Provider{
		ID: "codex", Name: "Codex", Protocol: config.ProtocolOpenAIResponses,
		BaseURL: "https://chatgpt.com/backend-api/codex",
		Auth:    config.AuthConfig{Type: "codex-oauth", File: "~/.codex/auth.json"},
		Paths:   map[string]string{"responses": "/responses", "models": "/models"},
		Models:  list, Source: "scan",
		Notes: "直连 ChatGPT OAuth；本机网络若不可达则请求会失败，apx 会如实报错。",
	}
	return f
}

func readCodexModel() string {
	raw, err := os.ReadFile(expandHome("~/.codex/config.toml"))
	if err != nil {
		return ""
	}
	re := regexp.MustCompile(`(?m)^\s*model\s*=\s*"([^"]+)"`)
	if m := re.FindStringSubmatch(string(raw)); len(m) == 2 {
		return m[1]
	}
	return ""
}

func scanZcode() Finding {
	f := Finding{ID: "zcode", Name: "Zcode / GLM Coding Plan", Kind: "harness"}
	path := expandHome("~/.zcode/v2/provider_config.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		f.Detail = "未找到 " + path
		return f
	}
	var doc struct {
		Config struct {
			ProviderConfigRules struct {
				ProviderRules []struct {
					ProviderID string `json:"providerId"`
					Config     struct {
						API struct {
							BaseURL string `json:"baseUrl"`
						} `json:"api"`
						Access struct {
							APIKey string `json:"apiKey"`
						} `json:"access"`
					} `json:"config"`
				} `json:"providerRules"`
			} `json:"providerConfigRules"`
		} `json:"config"`
	}
	_ = json.Unmarshal(raw, &doc)
	var bases []string
	key := ""
	for _, rule := range doc.Config.ProviderConfigRules.ProviderRules {
		if strings.Contains(rule.ProviderID, "magpie") {
			continue
		}
		if rule.Config.API.BaseURL != "" {
			bases = append(bases, rule.Config.API.BaseURL)
		}
		if key == "" && rule.Config.Access.APIKey != "" {
			key = rule.Config.Access.APIKey
		}
	}
	f.Available = key != ""
	f.Detail = fmt.Sprintf("明文 provider key=%v；端点 %s", f.Available, strings.Join(bases, ", "))
	f.Note = "只读取 Zcode 自己的 provider_config.json；加密的 credentials.json 不解密。"

	base := "https://open.bigmodel.cn/api/anthropic"
	protocol := config.ProtocolAnthropic
	if len(bases) > 0 {
		base = bases[0]
		protocol = config.ProtocolOpenAIChat
	}
	if f.Available {
		f.Healthy = probeModels(context.Background(), base, map[string]string{
			"Authorization": "Bearer " + key, "x-api-key": key, "anthropic-version": "2023-06-01",
		})
		if f.Healthy != nil && !*f.Healthy {
			f.Note = "key 已存在但端点拒绝/不可达；运行 apx auth set zcode --key 换新 key，或在 providers.json 里改 baseUrl。" + f.Note
		}
	}
	f.Models = []string{"glm-5.3", "glm-5.2", "glm-4.6"}
	list := make([]config.Model, 0, len(f.Models))
	for _, m := range f.Models {
		list = append(list, config.Model{ID: m})
	}
	f.Provider = &config.Provider{
		ID: "zcode", Name: "Zcode (GLM)", Protocol: protocol,
		BaseURL: base,
		Auth:    config.AuthConfig{Type: "zcode-key", Env: "APX_ZCODE_KEY"},
		Models:  list, Discover: true, Source: "scan",
		Notes: "baseUrl 取自 Zcode 自己的配置；如果换用官方端点，改成 https://open.bigmodel.cn/api/anthropic（Anthropic 协议）或 https://api.z.ai/api/anthropic。",
	}
	return f
}

func probeModels(ctx context.Context, base string, headers map[string]string) *bool {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	base = strings.TrimRight(base, "/")
	url := base + "/v1/models"
	if strings.HasSuffix(base, "/v1") {
		url = base + "/models"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		no := false
		return &no
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil // endpoint shape unknown; do not claim the key is bad
	}
	ok := resp.StatusCode < 400
	return &ok
}

func scanWorkBuddy() Finding {
	f := Finding{ID: "workbuddy", Name: "WorkBuddy (腾讯 CodeBuddy)", Kind: "harness"}
	modelsPath := expandHome("~/.workbuddy/models.json")
	raw, err := os.ReadFile(modelsPath)
	if err == nil {
		var list []struct {
			ID     string `json:"id"`
			URL    string `json:"url"`
			Vendor string `json:"vendor"`
		}
		if json.Unmarshal(raw, &list) == nil && len(list) > 0 {
			hosts := map[string]bool{}
			vendors := map[string]bool{}
			for _, m := range list {
				if m.URL != "" {
					hosts[m.URL] = true
				}
				if m.Vendor != "" {
					vendors[m.Vendor] = true
				}
			}
			f.Detail = fmt.Sprintf("models.json 有 %d 个模型；vendor=%s；URL=%s（这是 magpie 的模型清单，不是 WorkBuddy 原生端点）",
				len(list), joinKeys(vendors), joinKeys(hosts))
		}
	}

	key := strings.TrimSpace(os.Getenv("APX_WORKBUDDY_KEY"))
	if key == "" {
		if raw, err := os.ReadFile(config.CredentialsPath()); err == nil {
			var doc map[string]any
			if json.Unmarshal(raw, &doc) == nil {
				key, _ = doc["workbuddy.key"].(string)
			}
		}
	}
	desktop := expandHome("~/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info")
	encrypted := false
	if raw, err := os.ReadFile(desktop); err == nil {
		encrypted = strings.Contains(string(raw), "wbEncrypted") || strings.Contains(string(raw), "enc:v1:")
	}
	f.Available = key != ""
	if key != "" {
		f.Detail = "已配置 API key（" + tail(key, 4) + "）"
		f.Healthy = probeModels(context.Background(), "https://copilot.tencent.com/v2", map[string]string{
			"X-API-Key": key, "Authorization": "Bearer " + key,
		})
	} else {
		f.Note = "WorkBuddy 桌面登录文件是加密的，apx 不解密。请用 `apx auth set workbuddy --key <key>` 写入 WorkBuddy 自己的 API key。"
		if encrypted {
			f.Note = "桌面登录文件已确认加密；" + f.Note
		}
	}
	models := []string{"deepseek-v4.1-flash", "glm-5.3-flash", "glm-5.3", "glm-5.2", "gpt-6-astra", "gpt-6.1-sol"}
	f.Models = models
	list := make([]config.Model, 0, len(models))
	for _, m := range models {
		list = append(list, config.Model{ID: m})
	}
	f.Provider = &config.Provider{
		ID: "workbuddy", Name: "WorkBuddy", Protocol: config.ProtocolOpenAIChat,
		BaseURL: "https://copilot.tencent.com/v2",
		Auth:    config.AuthConfig{Type: "workbuddy-key", Env: "APX_WORKBUDDY_KEY"},
		Paths:   map[string]string{"chat": "/chat/completions", "models": "/models"},
		Models:  list, Discover: true, Source: "scan",
		Notes: "中国版端点 copilot.tencent.com/v2；国际版把 baseUrl 改成 https://www.workbuddy.ai/v2。模型名来自 WorkBuddy 自己的 models.json。",
	}
	return f
}

func scanOpenCode() Finding {
	f := Finding{ID: "opencode", Name: "OpenCode", Kind: "harness"}
	path := expandHome("~/.local/share/opencode/opencode.db")
	if _, err := os.Stat(path); err != nil {
		f.Detail = "未找到 " + path
		return f
	}
	f.Available = true
	f.Detail = "发现本地数据库 " + path
	f.Note = "v2 暂不直接读取其 SQLite；v1 适配器仍可用。"
	return f
}

func scanDSH() Finding {
	f := Finding{ID: "dsh", Name: "DeepSeek Harness", Kind: "harness"}
	path := expandHome("~/.dsh/.credentials.yaml")
	if _, err := os.Stat(path); err != nil {
		f.Detail = "未找到 " + path
		return f
	}
	f.Available = true
	f.Detail = "发现明文 YAML 凭据 " + path
	f.Note = "可后续加 dsh 适配器；本版先完成协议与路由。"
	return f
}

// Seed turns a scan report into a registry. Providers are ordered by how much we
// trust them to work: local models first, then harnesses that are actually
// reachable, then harnesses that only need a key.
func Seed(rep Report) config.Registry {
	var reg config.Registry
	for _, f := range rep.Findings {
		if f.Provider == nil {
			continue
		}
		p := *f.Provider
		if p.ID == "ollama" {
			p.Models = nil
			for _, m := range f.Models {
				p.Models = append(p.Models, config.Model{ID: m})
			}
			p.Discover = true
		}
		reg.Providers = append(reg.Providers, p)
	}
	var local, harnesses, keyOnly []string
	for _, f := range rep.Findings {
		if f.Provider == nil {
			continue
		}
		switch {
		case f.Provider.ID == "ollama":
			local = append(local, f.Provider.ID)
		case f.Available && (f.Healthy == nil || *f.Healthy):
			harnesses = append(harnesses, f.Provider.ID)
		default:
			keyOnly = append(keyOnly, f.Provider.ID)
		}
	}
	if len(harnesses)+len(local) > 0 {
		reg.Groups = append(reg.Groups, config.Group{
			ID: "auto", Name: "自动路由", Strategy: "order",
			Providers: append(append(harnesses, local...), keyOnly...),
		})
	}
	return reg
}

func expandHome(p string) string {
	if strings.HasPrefix(p, "~") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(p, "~"), string(filepath.Separator)))
	}
	return p
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func joinKeys(m map[string]bool) string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return strings.Join(out, ", ")
}
