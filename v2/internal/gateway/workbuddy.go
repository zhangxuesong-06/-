package gateway

import (
	"context"
	"net/http"
	"time"

	"apx2/internal/auth"
)

type wbLoginState struct {
	Status  string `json:"status"` // idle | pending | success | error
	Message string `json:"message,omitempty"`
	URL     string `json:"url,omitempty"`
	Account string `json:"account,omitempty"`
}

func (s *Server) setWBLogin(provider string, st wbLoginState) {
	s.wbMu.Lock()
	defer s.wbMu.Unlock()
	s.wbLogins[provider] = &st
}

func (s *Server) getWBLogin(provider string) wbLoginState {
	s.wbMu.Lock()
	defer s.wbMu.Unlock()
	if st := s.wbLogins[provider]; st != nil {
		return *st
	}
	return wbLoginState{Status: "idle"}
}

// handleWorkBuddyLogin starts WorkBuddy's own browser sign-in (POST) and reports
// its progress (GET). The tokens land in ~/.apx2/auth/workbuddy.json; magpie's
// files are not read.
func (s *Server) handleWorkBuddyLogin(w http.ResponseWriter, r *http.Request, providerID string) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.getWBLogin(providerID))
	case http.MethodPost:
		if _, ok := s.rt.Registry().Provider(providerID); !ok {
			writeError(w, http.StatusNotFound, "apx_provider_not_found", "没有这个 provider")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		login, err := auth.StartWorkBuddyLogin(ctx)
		if err != nil {
			writeError(w, http.StatusBadGateway, "apx_workbuddy_login", err.Error())
			return
		}
		s.setWBLogin(providerID, wbLoginState{Status: "pending", URL: login.URL})
		auth.OpenWorkBuddyLogin(login.URL)
		go s.finishWorkBuddyLogin(providerID, login)
		writeJSON(w, http.StatusOK, map[string]any{"status": "pending", "url": login.URL})
	default:
		writeError(w, http.StatusMethodNotAllowed, "apx_method_not_allowed", "use GET or POST")
	}
}

func (s *Server) finishWorkBuddyLogin(providerID string, login auth.WorkBuddyLogin) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute+30*time.Second)
	defer cancel()
	tok, err := auth.PollWorkBuddyLogin(ctx, login)
	if err != nil {
		s.setWBLogin(providerID, wbLoginState{Status: "error", Message: err.Error()})
		return
	}
	path, err := auth.WorkBuddyTokenPath("")
	if err != nil {
		s.setWBLogin(providerID, wbLoginState{Status: "error", Message: err.Error()})
		return
	}
	if err := auth.SaveWorkBuddyToken(path, tok); err != nil {
		s.setWBLogin(providerID, wbLoginState{Status: "error", Message: err.Error()})
		return
	}

	reg := s.rt.Registry()
	idx := -1
	for i := range reg.Providers {
		if reg.Providers[i].ID == providerID {
			idx = i
			break
		}
	}
	if idx < 0 {
		s.setWBLogin(providerID, wbLoginState{Status: "error", Message: "provider 已删除"})
		return
	}
	p := reg.Providers[idx]
	p.Auth.Type = "workbuddy-oauth"
	p.Auth.File = "~/.apx2/auth/workbuddy.json"
	p.Auth.Env = ""
	p.Discover = true
	reg.Providers[idx] = p
	_ = s.saveRegistry(reg)

	msg := "登录成功"
	if models, err := s.up.ListModels(ctx, p, auth.Build(p), 20*time.Second); err == nil {
		p.Models = mergeModels(p.Models, models)
		reg = s.rt.Registry()
		for i := range reg.Providers {
			if reg.Providers[i].ID == providerID {
				reg.Providers[i] = p
				break
			}
		}
		_ = s.saveRegistry(reg)
		msg = "登录成功，已发现 " + itoa(len(p.Models)) + " 个模型"
	} else {
		msg = "登录成功；模型发现失败：" + err.Error()
	}
	s.setWBLogin(providerID, wbLoginState{Status: "success", Message: msg, Account: tok.AccountName})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
