package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"apx2/internal/auth"
	"apx2/internal/config"
)

var providerIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,47}$`)

var validProtocols = map[string]bool{
	config.ProtocolOpenAIChat:      true,
	config.ProtocolOpenAIResponses: true,
	config.ProtocolAnthropic:       true,
}

var validAuthTypes = map[string]bool{
	"none": true, "bearer": true, "header": true,
	"codex-oauth": true, "workbuddy-key": true, "zcode-key": true,
	"zcode-config": true, "workbuddy-oauth": true, "zcode-oauth": true,
}

type providerPayload struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Protocol string            `json:"protocol"`
	BaseURL  string            `json:"baseUrl"`
	Proxy    string            `json:"proxy"`
	TLSMax   string            `json:"tlsMax"`
	AuthType string            `json:"authType"`
	Env      string            `json:"env"`
	File     string            `json:"file"`
	JSONPath string            `json:"jsonPath"`
	APIKey   string            `json:"apiKey"`
	Notes    string            `json:"notes"`
	Models   []string          `json:"models"`
	Paths    map[string]string `json:"paths"`
	Discover *bool             `json:"discover"`
	Disabled *bool             `json:"disabled"`
}

type groupPayload struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Strategy  string   `json:"strategy"`
	Providers []string `json:"providers"`
}

// handleAdmin dispatches the local management API. Everything here mutates the
// registry, so the apx token is required (checked by serveHTTP).
func (s *Server) handleAdmin(w http.ResponseWriter, r *http.Request) {
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/"), "/")
	parts := strings.Split(path, "/")
	switch parts[0] {
	case "providers":
		s.handleAdminProviders(w, r, parts[1:])
	case "groups":
		s.handleAdminGroups(w, r, parts[1:])
	default:
		writeError(w, http.StatusNotFound, "apx_not_found", "未知管理接口")
	}
}

func (s *Server) handleAdminProviders(w http.ResponseWriter, r *http.Request, rest []string) {
	switch len(rest) {
	case 0:
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "apx_method_not_allowed", "use POST")
			return
		}
		s.upsertProvider(w, r)
	case 1:
		id := rest[0]
		switch r.Method {
		case http.MethodPatch, http.MethodPost:
			s.patchProvider(w, r, id)
		case http.MethodDelete:
			s.deleteProvider(w, id)
		default:
			writeError(w, http.StatusMethodNotAllowed, "apx_method_not_allowed", "use PATCH or DELETE")
		}
	case 2:
		id := rest[0]
		switch rest[1] {
		case "key":
			s.setProviderKey(w, r, id)
		case "discover":
			s.discoverProvider(w, r, id)
		case "test":
			s.testProvider(w, r, id)
		case "login":
			s.handleWorkBuddyLogin(w, r, id)
		case "accounts":
			if r.Method != http.MethodPost {
				writeError(w, http.StatusMethodNotAllowed, "apx_method_not_allowed", "use POST")
				return
			}
			s.upsertAccount(w, r, id)
		default:
			writeError(w, http.StatusNotFound, "apx_not_found", "未知 provider 操作")
		}
	case 3:
		id, account := rest[0], rest[2]
		if rest[1] != "accounts" {
			writeError(w, http.StatusNotFound, "apx_not_found", "未知 provider 路径")
			return
		}
		switch r.Method {
		case http.MethodPatch, http.MethodPost:
			s.patchAccount(w, r, id, account)
		case http.MethodDelete:
			s.deleteAccount(w, id, account)
		default:
			writeError(w, http.StatusMethodNotAllowed, "apx_method_not_allowed", "use PATCH or DELETE")
		}
	default:
		writeError(w, http.StatusNotFound, "apx_not_found", "未知 provider 路径")
	}
}

func (s *Server) handleAdminGroups(w http.ResponseWriter, r *http.Request, rest []string) {
	switch len(rest) {
	case 0:
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "apx_method_not_allowed", "use POST")
			return
		}
		s.upsertGroup(w, r)
	case 1:
		if r.Method != http.MethodDelete {
			writeError(w, http.StatusMethodNotAllowed, "apx_method_not_allowed", "use DELETE")
			return
		}
		s.deleteGroup(w, rest[0])
	default:
		writeError(w, http.StatusNotFound, "apx_not_found", "未知 group 路径")
	}
}

func decodeJSON(r *http.Request, v any) error {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		return err
	}
	if len(raw) == 0 {
		return fmt.Errorf("请求体为空")
	}
	return json.Unmarshal(raw, v)
}

func (s *Server) saveRegistry(reg config.Registry) error {
	if err := reg.Save(); err != nil {
		return err
	}
	s.rt.Reload(reg, s.cfg.Aliases)
	return nil
}

func (s *Server) upsertProvider(w http.ResponseWriter, r *http.Request) {
	var payload providerPayload
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "apx_bad_json", err.Error())
		return
	}
	id := strings.TrimSpace(payload.ID)
	if !providerIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "apx_bad_provider_id", "provider id 只能用小写字母、数字、- 和 _，且以字母/数字开头")
		return
	}
	if strings.TrimSpace(payload.BaseURL) == "" {
		writeError(w, http.StatusBadRequest, "apx_bad_base_url", "baseUrl 不能为空")
		return
	}
	protocol := firstNonEmpty(payload.Protocol, config.ProtocolOpenAIChat)
	if !validProtocols[protocol] {
		writeError(w, http.StatusBadRequest, "apx_bad_protocol", "protocol 必须是 openai-chat / openai-responses / anthropic")
		return
	}
	authType := firstNonEmpty(payload.AuthType, "none")
	if !validAuthTypes[authType] {
		writeError(w, http.StatusBadRequest, "apx_bad_auth", "未知的 authType")
		return
	}
	if payload.APIKey != "" && authType == "none" {
		authType = "bearer"
	}
	if payload.APIKey != "" {
		if err := auth.SetSecret(id, "key", payload.APIKey); err != nil {
			writeError(w, http.StatusInternalServerError, "apx_key_store", err.Error())
			return
		}
	}

	reg := s.rt.Registry()
	idx := -1
	for i := range reg.Providers {
		if reg.Providers[i].ID == id {
			idx = i
			break
		}
	}
	var p config.Provider
	if idx >= 0 {
		p = reg.Providers[idx]
	}
	p.ID = id
	p.Name = firstNonEmpty(strings.TrimSpace(payload.Name), p.Name, id)
	p.Protocol = protocol
	p.BaseURL = strings.TrimRight(strings.TrimSpace(payload.BaseURL), "/")
	p.Proxy = strings.TrimSpace(payload.Proxy)
	p.TLSMax = strings.TrimSpace(payload.TLSMax)
	p.Notes = strings.TrimSpace(payload.Notes)
	p.Disabled = payload.Disabled != nil && *payload.Disabled
	p.Discover = payload.Discover != nil && *payload.Discover
	p.Auth.Type = authType
	if payload.Env != "" {
		p.Auth.Env = payload.Env
	}
	if payload.File != "" {
		p.Auth.File = payload.File
	}
	if payload.JSONPath != "" {
		p.Auth.JSONPath = payload.JSONPath
	}
	if payload.Models != nil {
		p.Models = applyEnabledModels(p.Models, payload.Models)
	}
	if payload.Paths != nil {
		p.Paths = payload.Paths
	}
	if idx >= 0 {
		reg.Providers[idx] = p
	} else {
		reg.Providers = append(reg.Providers, p)
	}
	if err := s.saveRegistry(reg); err != nil {
		writeError(w, http.StatusInternalServerError, "apx_registry_save", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "models": len(p.Models)})
}

func (s *Server) patchProvider(w http.ResponseWriter, r *http.Request, id string) {
	var payload struct {
		Disabled      *bool    `json:"disabled"`
		EnabledModels []string `json:"enabledModels"`
		Name          string   `json:"name"`
		Notes         string   `json:"notes"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "apx_bad_json", err.Error())
		return
	}
	reg := s.rt.Registry()
	idx := -1
	for i := range reg.Providers {
		if reg.Providers[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		writeError(w, http.StatusNotFound, "apx_provider_not_found", "没有这个 provider")
		return
	}
	p := reg.Providers[idx]
	if payload.Disabled != nil {
		p.Disabled = *payload.Disabled
	}
	if payload.Name != "" {
		p.Name = payload.Name
	}
	if payload.Notes != "" {
		p.Notes = payload.Notes
	}
	if payload.EnabledModels != nil {
		p.Models = applyEnabledModels(p.Models, payload.EnabledModels)
	}
	reg.Providers[idx] = p
	if err := s.saveRegistry(reg); err != nil {
		writeError(w, http.StatusInternalServerError, "apx_registry_save", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "disabled": p.Disabled, "models": p.Models})
}

func (s *Server) deleteProvider(w http.ResponseWriter, id string) {
	reg := s.rt.Registry()
	found := false
	out := reg.Providers[:0]
	for _, p := range reg.Providers {
		if p.ID == id {
			found = true
			continue
		}
		out = append(out, p)
	}
	if !found {
		writeError(w, http.StatusNotFound, "apx_provider_not_found", "没有这个 provider")
		return
	}
	reg.Providers = out
	for i := range reg.Groups {
		var keep []string
		for _, pid := range reg.Groups[i].Providers {
			if pid != id {
				keep = append(keep, pid)
			}
		}
		reg.Groups[i].Providers = keep
	}
	if err := s.saveRegistry(reg); err != nil {
		writeError(w, http.StatusInternalServerError, "apx_registry_save", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id})
}

func (s *Server) setProviderKey(w http.ResponseWriter, r *http.Request, id string) {
	var payload struct {
		APIKey string `json:"apiKey"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "apx_bad_json", err.Error())
		return
	}
	key := strings.TrimSpace(payload.APIKey)
	if key == "" {
		writeError(w, http.StatusBadRequest, "apx_bad_key", "apiKey 不能为空")
		return
	}
	reg := s.rt.Registry()
	idx := -1
	for i := range reg.Providers {
		if reg.Providers[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		writeError(w, http.StatusNotFound, "apx_provider_not_found", "没有这个 provider")
		return
	}
	if err := auth.SetSecret(id, "key", key); err != nil {
		writeError(w, http.StatusInternalServerError, "apx_key_store", err.Error())
		return
	}
	p := reg.Providers[idx]
	if p.Auth.Type == "" || p.Auth.Type == "none" {
		p.Auth.Type = "bearer"
	}
	reg.Providers[idx] = p
	if err := s.saveRegistry(reg); err != nil {
		writeError(w, http.StatusInternalServerError, "apx_registry_save", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "keySet": true})
}

func (s *Server) discoverProvider(w http.ResponseWriter, r *http.Request, id string) {
	p, ok := s.rt.Registry().Provider(id)
	if !ok {
		writeError(w, http.StatusNotFound, "apx_provider_not_found", "没有这个 provider")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	models, err := s.up.ListModels(ctx, p, providerAuth(p), 15*time.Second)
	if err != nil {
		writeError(w, http.StatusBadGateway, "apx_discover_failed", err.Error())
		return
	}
	reg := s.rt.Registry()
	for i := range reg.Providers {
		if reg.Providers[i].ID == id {
			reg.Providers[i].Models = mergeModels(reg.Providers[i].Models, models)
			p = reg.Providers[i]
			break
		}
	}
	if err := s.saveRegistry(reg); err != nil {
		writeError(w, http.StatusInternalServerError, "apx_registry_save", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "models": p.Models, "count": len(p.Models)})
}

func (s *Server) testProvider(w http.ResponseWriter, r *http.Request, id string) {
	p, ok := s.rt.Registry().Provider(id)
	if !ok {
		writeError(w, http.StatusNotFound, "apx_provider_not_found", "没有这个 provider")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	start := time.Now()
	models, err := s.up.ListModels(ctx, p, providerAuth(p), 15*time.Second)
	ms := time.Since(start).Milliseconds()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false, "id": id, "latencyMs": ms, "message": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "id": id, "latencyMs": ms, "models": len(models),
	})
}

func (s *Server) upsertGroup(w http.ResponseWriter, r *http.Request) {
	var payload groupPayload
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "apx_bad_json", err.Error())
		return
	}
	id := strings.TrimSpace(payload.ID)
	if !providerIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "apx_bad_group_id", "路由组 id 只能用小写字母、数字、- 和 _")
		return
	}
	strategy := firstNonEmpty(payload.Strategy, "order")
	switch strategy {
	case "order", "rotate", "usage":
	default:
		writeError(w, http.StatusBadRequest, "apx_bad_strategy", "strategy 必须是 order / rotate / usage")
		return
	}
	reg := s.rt.Registry()
	for _, pid := range payload.Providers {
		if _, ok := reg.Provider(pid); !ok {
			writeError(w, http.StatusBadRequest, "apx_unknown_provider", "路由组引用了不存在的 provider: "+pid)
			return
		}
	}
	g := config.Group{
		ID: id, Name: strings.TrimSpace(payload.Name), Strategy: strategy,
		Providers: dedupeStrings(payload.Providers),
	}
	idx := -1
	for i := range reg.Groups {
		if reg.Groups[i].ID == id {
			idx = i
			break
		}
	}
	if idx >= 0 {
		reg.Groups[idx] = g
	} else {
		reg.Groups = append(reg.Groups, g)
	}
	if err := s.saveRegistry(reg); err != nil {
		writeError(w, http.StatusInternalServerError, "apx_registry_save", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "group": g})
}

func (s *Server) deleteGroup(w http.ResponseWriter, id string) {
	reg := s.rt.Registry()
	found := false
	out := reg.Groups[:0]
	for _, g := range reg.Groups {
		if g.ID == id {
			found = true
			continue
		}
		out = append(out, g)
	}
	if !found {
		writeError(w, http.StatusNotFound, "apx_group_not_found", "没有这个路由组")
		return
	}
	reg.Groups = out
	if err := s.saveRegistry(reg); err != nil {
		writeError(w, http.StatusInternalServerError, "apx_registry_save", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id})
}

// applyEnabledModels keeps disabled models in the registry (so the UI can
// re-enable them) while the router only exposes enabled ones.
func applyEnabledModels(old []config.Model, ids []string) []config.Model {
	enabled := map[string]bool{}
	for _, id := range ids {
		if s := strings.TrimSpace(id); s != "" {
			enabled[s] = true
		}
	}
	out := make([]config.Model, 0, len(old)+len(enabled))
	seen := map[string]bool{}
	for _, m := range old {
		if m.ID == "" {
			continue
		}
		seen[m.ID] = true
		m.Disabled = !enabled[m.ID]
		out = append(out, m)
	}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, config.Model{ID: id})
	}
	return out
}

func dedupeStrings(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func (s *Server) upsertAccount(w http.ResponseWriter, r *http.Request, providerID string) {
	var payload struct {
		ID       string    `json:"id"`
		Name     string    `json:"name"`
		APIKey   string    `json:"apiKey"`
		AuthType string    `json:"authType"`
		Env      string    `json:"env"`
		File     string    `json:"file"`
		JSONPath string    `json:"jsonPath"`
		Models   *[]string `json:"models"`
		Disabled *bool     `json:"disabled"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "apx_bad_json", err.Error())
		return
	}
	id := strings.TrimSpace(payload.ID)
	if !providerIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "apx_bad_account_id", "账号 id 只能用小写字母、数字、- 和 _")
		return
	}
	reg := s.rt.Registry()
	pidx := -1
	for i := range reg.Providers {
		if reg.Providers[i].ID == providerID {
			pidx = i
			break
		}
	}
	if pidx < 0 {
		writeError(w, http.StatusNotFound, "apx_provider_not_found", "没有这个 provider")
		return
	}
	p := reg.Providers[pidx]
	var acct config.Account
	aidx := -1
	for i := range p.Accounts {
		if p.Accounts[i].ID == id {
			aidx = i
			acct = p.Accounts[i]
			break
		}
	}
	acct.ID = id
	if payload.Name != "" {
		acct.Name = strings.TrimSpace(payload.Name)
	}
	if payload.AuthType != "" {
		if !validAuthTypes[payload.AuthType] {
			writeError(w, http.StatusBadRequest, "apx_bad_auth", "未知的 authType")
			return
		}
		acct.Auth.Type = payload.AuthType
	}
	if payload.Env != "" {
		acct.Auth.Env = payload.Env
	}
	if payload.File != "" {
		acct.Auth.File = payload.File
	}
	if payload.JSONPath != "" {
		acct.Auth.JSONPath = payload.JSONPath
	}
	if payload.Disabled != nil {
		acct.Disabled = *payload.Disabled
	}
	if payload.Models != nil {
		acct.Models = dedupeStrings(*payload.Models)
	}
	if payload.APIKey != "" {
		if err := auth.SetSecret(providerID+"#"+id, "key", strings.TrimSpace(payload.APIKey)); err != nil {
			writeError(w, http.StatusInternalServerError, "apx_key_store", err.Error())
			return
		}
		if acct.Auth.Type == "" && (p.Auth.Type == "" || p.Auth.Type == "none") {
			acct.Auth.Type = "bearer"
		}
	}
	if aidx >= 0 {
		p.Accounts[aidx] = acct
	} else {
		p.Accounts = append(p.Accounts, acct)
	}
	reg.Providers[pidx] = p
	if err := s.saveRegistry(reg); err != nil {
		writeError(w, http.StatusInternalServerError, "apx_registry_save", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "label": auth.DescribeAccount(p, &acct).Label})
}

func (s *Server) patchAccount(w http.ResponseWriter, r *http.Request, providerID, accountID string) {
	var payload struct {
		Name     string    `json:"name"`
		APIKey   string    `json:"apiKey"`
		AuthType string    `json:"authType"`
		Models   *[]string `json:"models"`
		Disabled *bool     `json:"disabled"`
	}
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, "apx_bad_json", err.Error())
		return
	}
	reg := s.rt.Registry()
	pidx := -1
	for i := range reg.Providers {
		if reg.Providers[i].ID == providerID {
			pidx = i
			break
		}
	}
	if pidx < 0 {
		writeError(w, http.StatusNotFound, "apx_provider_not_found", "没有这个 provider")
		return
	}
	p := reg.Providers[pidx]
	aidx := -1
	for i := range p.Accounts {
		if p.Accounts[i].ID == accountID {
			aidx = i
			break
		}
	}
	if aidx < 0 {
		writeError(w, http.StatusNotFound, "apx_account_not_found", "没有这个账号")
		return
	}
	acct := p.Accounts[aidx]
	if payload.Name != "" {
		acct.Name = strings.TrimSpace(payload.Name)
	}
	if payload.Disabled != nil {
		acct.Disabled = *payload.Disabled
	}
	if payload.Models != nil {
		acct.Models = dedupeStrings(*payload.Models)
	}
	if payload.AuthType != "" {
		if !validAuthTypes[payload.AuthType] {
			writeError(w, http.StatusBadRequest, "apx_bad_auth", "未知的 authType")
			return
		}
		acct.Auth.Type = payload.AuthType
	}
	if payload.APIKey != "" {
		if err := auth.SetSecret(providerID+"#"+accountID, "key", strings.TrimSpace(payload.APIKey)); err != nil {
			writeError(w, http.StatusInternalServerError, "apx_key_store", err.Error())
			return
		}
		if acct.Auth.Type == "" && (p.Auth.Type == "" || p.Auth.Type == "none") {
			acct.Auth.Type = "bearer"
		}
	}
	p.Accounts[aidx] = acct
	reg.Providers[pidx] = p
	if err := s.saveRegistry(reg); err != nil {
		writeError(w, http.StatusInternalServerError, "apx_registry_save", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": accountID, "label": auth.DescribeAccount(p, &acct).Label})
}

func (s *Server) deleteAccount(w http.ResponseWriter, providerID, accountID string) {
	reg := s.rt.Registry()
	pidx := -1
	for i := range reg.Providers {
		if reg.Providers[i].ID == providerID {
			pidx = i
			break
		}
	}
	if pidx < 0 {
		writeError(w, http.StatusNotFound, "apx_provider_not_found", "没有这个 provider")
		return
	}
	p := reg.Providers[pidx]
	aidx := -1
	for i := range p.Accounts {
		if p.Accounts[i].ID == accountID {
			aidx = i
			break
		}
	}
	if aidx < 0 {
		writeError(w, http.StatusNotFound, "apx_account_not_found", "没有这个账号")
		return
	}
	p.Accounts = append(p.Accounts[:aidx], p.Accounts[aidx+1:]...)
	reg.Providers[pidx] = p
	if err := s.saveRegistry(reg); err != nil {
		writeError(w, http.StatusInternalServerError, "apx_registry_save", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": accountID})
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
