package auth

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"apx2/internal/config"
)

// WorkBuddy's verified client identity (WorkBuddy desktop 5.9.3, bundled CLI
// 2.165.0). These values are what WorkBuddy's backend expects from its own
// client; other values are refused or attributed to no client.
const (
	wbEndpoint  = "https://copilot.tencent.com"
	wbApp       = "5.9.3"
	wbCLI       = "2.165.0"
	wbDefault   = "~/.apx2/auth/workbuddy.json"
	wbLoginWait = 5 * time.Minute
	wbEarlyMS   = 60 * 1000
)

type WorkBuddyToken struct {
	Access           string `json:"access"`
	Refresh          string `json:"refresh"`
	Expires          int64  `json:"expires"`
	RefreshExpiresAt int64  `json:"refreshExpiresAt,omitempty"`
	UID              string `json:"uid"`
	Domain           string `json:"domain,omitempty"`
	EnterpriseID     string `json:"enterpriseId,omitempty"`
	TokenType        string `json:"tokenType,omitempty"`
	AccountName      string `json:"accountName,omitempty"`
}

type wbEnvelope struct {
	Code int             `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

var wbRefreshMu sync.Mutex
var wbRefreshLocks = map[string]*sync.Mutex{}

func wbLock(path string) *sync.Mutex {
	wbRefreshMu.Lock()
	defer wbRefreshMu.Unlock()
	l := wbRefreshLocks[path]
	if l == nil {
		l = &sync.Mutex{}
		wbRefreshLocks[path] = l
	}
	return l
}

func WorkBuddyTokenPath(account string) (string, error) {
	dir, err := config.StateDir()
	if err != nil {
		return "", err
	}
	dir = filepath.Join(dir, "auth")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	name := "workbuddy"
	if account != "" {
		name += "#" + account
	}
	return filepath.Join(dir, name+".json"), nil
}

func LoadWorkBuddyToken(path string) (WorkBuddyToken, error) {
	var t WorkBuddyToken
	raw, err := os.ReadFile(expandHome(path))
	if err != nil {
		return t, err
	}
	if err := json.Unmarshal(raw, &t); err != nil {
		return t, err
	}
	if t.Access == "" {
		return t, fmt.Errorf("%s 中没有 WorkBuddy access token", path)
	}
	return t, nil
}

func SaveWorkBuddyToken(path string, t WorkBuddyToken) error {
	path = expandHome(path)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// WorkBuddyHeaders are the headers WorkBuddy's own client sends on every call.
func WorkBuddyHeaders(t WorkBuddyToken) map[string]string {
	domain := t.Domain
	if domain == "" {
		domain = "copilot.tencent.com"
	}
	h := map[string]string{
		"Authorization":               "Bearer " + t.Access,
		"X-User-Id":                   t.UID,
		"X-Domain":                    domain,
		"X-Product":                   "SaaS",
		"X-IDE-Type":                  "WorkBuddy",
		"User-Agent":                  "WorkBuddy/" + wbApp + " WorkBuddy/" + wbApp + " CLI/" + wbCLI,
		"X-Requested-With":            "XMLHttpRequest",
		"X-Agent-Intent":              "craft",
		"X-Agent-Purpose":             "conversation",
		"X-IDE-Name":                  "WorkBuddy",
		"X-IDE-Version":               wbApp,
		"Accept":                      "application/json",
		"X-Stainless-Lang":            "js",
		"X-Stainless-OS":              "Windows",
		"X-Stainless-Arch":            "x64",
		"X-Stainless-Runtime":         "node",
		"X-Stainless-Runtime-Version": "v22.21.1",
	}
	if t.EnterpriseID != "" {
		h["X-Enterprise-Id"] = t.EnterpriseID
		h["X-Tenant-Id"] = t.EnterpriseID
	}
	return h
}

func WorkBuddyChatHeaders() map[string]string {
	return map[string]string{
		"X-Agent-Type":              "main",
		"X-Agent-Runtime":           "local-agent",
		"X-Conversation-ID":         wbUUID(),
		"X-Conversation-Request-ID": wbUUID(),
		"X-Conversation-Message-ID": wbUUID(),
		"X-Request-ID":              wbUUID(),
	}
}

// WorkBuddyKeyHeaders is the API-key flavour of the same client identity.
func WorkBuddyKeyHeaders(key string) map[string]string {
	h := map[string]string{
		"Authorization":               "Bearer " + key,
		"X-API-Key":                   key,
		"X-User-Id":                   "anonymous_" + tail(key, 8),
		"X-Product":                   "SaaS",
		"X-IDE-Type":                  "WorkBuddy",
		"User-Agent":                  "WorkBuddy/" + wbApp + " WorkBuddy/" + wbApp + " CLI/" + wbCLI,
		"X-Requested-With":            "XMLHttpRequest",
		"X-Agent-Intent":              "craft",
		"X-Agent-Purpose":             "conversation",
		"X-IDE-Name":                  "WorkBuddy",
		"X-IDE-Version":               wbApp,
		"Accept":                      "application/json",
		"X-Stainless-Lang":            "js",
		"X-Stainless-OS":              "Windows",
		"X-Stainless-Arch":            "x64",
		"X-Stainless-Runtime":         "node",
		"X-Stainless-Runtime-Version": "v22.21.1",
	}
	if v := os.Getenv("APX_WORKBUDDY_ENTERPRISE_ID"); v != "" {
		h["X-Enterprise-Id"] = v
		h["X-Tenant-Id"] = v
	}
	if v := os.Getenv("APX_WORKBUDDY_TENANT_ID"); v != "" {
		h["X-Tenant-Id"] = v
	}
	return h
}

func wbUUID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

func wbCall(ctx context.Context, method, path string, headers map[string]string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, wbEndpoint+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "WorkBuddy/"+wbApp)
	for k, v := range headers {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	var env wbEnvelope
	_ = json.Unmarshal(raw, &env)
	if resp.StatusCode >= 400 || (env.Code != 0 && env.Code != 11217 && env.Code != 12151) {
		msg := env.Msg
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
		}
		if msg == "" {
			msg = resp.Status
		}
		return nil, fmt.Errorf("WorkBuddy: %s (HTTP %d, code %d)", msg, resp.StatusCode, env.Code)
	}
	if env.Code == 11217 || env.Code == 12151 {
		return nil, fmt.Errorf("workbuddy_pending:%d", env.Code)
	}
	return env.Data, nil
}

type WorkBuddyLogin struct {
	URL   string `json:"url"`
	State string `json:"state"`
}

func StartWorkBuddyLogin(ctx context.Context) (WorkBuddyLogin, error) {
	data, err := wbCall(ctx, http.MethodPost, "/v2/plugin/auth/state?platform=workbuddy", map[string]string{
		"X-No-Authorization":   "true",
		"X-No-User-Id":         "true",
		"X-No-Enterprise-Id":   "true",
		"X-No-Department-Info": "true",
	}, map[string]any{})
	if err != nil {
		return WorkBuddyLogin{}, err
	}
	var st struct {
		State   string `json:"state"`
		AuthURL string `json:"authUrl"`
	}
	if err := json.Unmarshal(data, &st); err != nil {
		return WorkBuddyLogin{}, err
	}
	if st.State == "" || st.AuthURL == "" {
		return WorkBuddyLogin{}, fmt.Errorf("WorkBuddy 没有返回登录地址")
	}
	u, err := url.Parse(st.AuthURL)
	if err != nil || u.Scheme != "https" {
		return WorkBuddyLogin{}, fmt.Errorf("WorkBuddy 登录地址不是 https")
	}
	q := u.Query()
	q.Set("version", wbApp)
	q.Set("loginSessionId", hex.EncodeToString(randomBytes(16)))
	u.RawQuery = q.Encode()
	return WorkBuddyLogin{URL: u.String(), State: st.State}, nil
}

func PollWorkBuddyLogin(ctx context.Context, login WorkBuddyLogin) (WorkBuddyToken, error) {
	var t WorkBuddyToken
	deadline := time.Now().Add(wbLoginWait)
	q := url.QueryEscape(login.State)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return t, ctx.Err()
		default:
		}
		data, err := wbCall(ctx, http.MethodGet, "/v2/plugin/auth/token?state="+q, nil, nil)
		if err == nil {
			var tok struct {
				AccessToken      string `json:"accessToken"`
				RefreshToken     string `json:"refreshToken"`
				ExpiresAt        int64  `json:"expiresAt"`
				ExpiresIn        int64  `json:"expiresIn"`
				RefreshExpiresAt int64  `json:"refreshExpiresAt"`
				RefreshExpiresIn int64  `json:"refreshExpiresIn"`
				Domain           string `json:"domain"`
				TokenType        string `json:"tokenType"`
			}
			if json.Unmarshal(data, &tok) == nil && tok.AccessToken != "" {
				t.Access = tok.AccessToken
				t.Refresh = tok.RefreshToken
				t.Domain = tok.Domain
				t.TokenType = tok.TokenType
				t.Expires = tok.ExpiresAt
				if t.Expires == 0 && tok.ExpiresIn > 0 {
					t.Expires = time.Now().UnixMilli() + tok.ExpiresIn*1000
				}
				t.RefreshExpiresAt = tok.RefreshExpiresAt
				if t.RefreshExpiresAt == 0 && tok.RefreshExpiresIn > 0 {
					t.RefreshExpiresAt = time.Now().UnixMilli() + tok.RefreshExpiresIn*1000
				}
				if err := fillWorkBuddyAccount(ctx, &t, login.State); err != nil {
					return t, err
				}
				return t, nil
			}
		} else if !strings.HasPrefix(err.Error(), "workbuddy_pending:") {
			return t, err
		}
		time.Sleep(time.Second)
	}
	return t, fmt.Errorf("WorkBuddy 登录超时")
}

func fillWorkBuddyAccount(ctx context.Context, t *WorkBuddyToken, state string) error {
	domain := t.Domain
	if domain == "" {
		domain = "copilot.tencent.com"
	}
	var lastErr error
	for i := 0; i < 30; i++ {
		data, err := wbCall(ctx, http.MethodGet, "/v2/plugin/login/account?state="+url.QueryEscape(state), map[string]string{
			"Authorization":      "Bearer " + t.Access,
			"X-Domain":           domain,
			"X-No-User-Id":       "true",
			"X-No-Enterprise-Id": "true",
		}, nil)
		if err == nil {
			var who struct {
				UID            string `json:"uid"`
				Nickname       string `json:"nickname"`
				PhoneNumber    string `json:"phoneNumber"`
				EnterpriseID   string `json:"enterpriseId"`
				EnterpriseName string `json:"enterpriseName"`
			}
			if json.Unmarshal(data, &who) == nil {
				t.UID = who.UID
				name := firstNonEmpty(who.Nickname, who.PhoneNumber, who.UID)
				if who.EnterpriseID != "" {
					t.EnterpriseID = who.EnterpriseID
					team := firstNonEmpty(who.EnterpriseName, "enterprise "+tail(who.EnterpriseID, 6))
					if name != "" {
						name += " · " + team
					} else {
						name = team
					}
				}
				t.AccountName = name
				if t.UID != "" {
					return nil
				}
			}
			lastErr = fmt.Errorf("WorkBuddy 没有返回账号 uid")
		} else {
			lastErr = err
			if !strings.HasPrefix(err.Error(), "workbuddy_pending:") {
				break
			}
		}
		time.Sleep(time.Second)
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("WorkBuddy 没有返回账号")
	}
	return lastErr
}

func RefreshWorkBuddyToken(ctx context.Context, t WorkBuddyToken) (WorkBuddyToken, error) {
	if t.Refresh == "" {
		return t, fmt.Errorf("WorkBuddy 没有 refresh token，需要重新登录")
	}
	data, err := wbCall(ctx, http.MethodPost, "/v2/plugin/auth/token/refresh", map[string]string{
		"X-Refresh-Token":       t.Refresh,
		"X-Auth-Refresh-Source": "plugin",
	}, map[string]any{})
	if err != nil {
		return t, err
	}
	var got struct {
		AccessToken      string `json:"accessToken"`
		RefreshToken     string `json:"refreshToken"`
		ExpiresAt        int64  `json:"expiresAt"`
		ExpiresIn        int64  `json:"expiresIn"`
		RefreshExpiresAt int64  `json:"refreshExpiresAt"`
		RefreshExpiresIn int64  `json:"refreshExpiresIn"`
		Domain           string `json:"domain"`
		TokenType        string `json:"tokenType"`
	}
	if err := json.Unmarshal(data, &got); err != nil {
		return t, err
	}
	if got.AccessToken == "" {
		return t, fmt.Errorf("WorkBuddy 刷新后没有 access token")
	}
	t.Access = got.AccessToken
	if got.RefreshToken != "" {
		t.Refresh = got.RefreshToken
	}
	if got.Domain != "" {
		t.Domain = got.Domain
	}
	if got.TokenType != "" {
		t.TokenType = got.TokenType
	}
	t.Expires = got.ExpiresAt
	if t.Expires == 0 && got.ExpiresIn > 0 {
		t.Expires = time.Now().UnixMilli() + got.ExpiresIn*1000
	}
	if got.RefreshExpiresAt > 0 {
		t.RefreshExpiresAt = got.RefreshExpiresAt
	}
	return t, nil
}

// EnsureWorkBuddyToken refreshes an expiring token and persists the result.
func EnsureWorkBuddyToken(ctx context.Context, path string) (WorkBuddyToken, error) {
	path = expandHome(path)
	lock := wbLock(path)
	lock.Lock()
	defer lock.Unlock()
	t, err := LoadWorkBuddyToken(path)
	if err != nil {
		return t, err
	}
	if t.Access != "" && (t.Expires == 0 || time.Now().UnixMilli() < t.Expires-wbEarlyMS) {
		return t, nil
	}
	if t.Refresh == "" || (t.RefreshExpiresAt > 0 && time.Now().UnixMilli() >= t.RefreshExpiresAt) {
		if t.Access != "" && (t.Expires == 0 || time.Now().UnixMilli() < t.Expires) {
			return t, nil
		}
		return t, fmt.Errorf("WorkBuddy 登录已过期，需要重新登录")
	}
	nt, err := RefreshWorkBuddyToken(ctx, t)
	if err != nil {
		if t.Access != "" && (t.Expires == 0 || time.Now().UnixMilli() < t.Expires) {
			return t, nil
		}
		return t, err
	}
	_ = SaveWorkBuddyToken(path, nt)
	return nt, nil
}

func WorkBuddyTokenIdentity(t WorkBuddyToken) Identity {
	label := t.AccountName
	if label == "" {
		label = t.UID
	}
	if label == "" {
		label = "WorkBuddy 账号"
	}
	return Identity{ID: t.UID, Label: label, Tail: tail(t.UID, 6)}
}

func randomBytes(n int) []byte {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return buf
}

// OpenWorkBuddyLogin opens the sign-in page in a dedicated browser window that
// bypasses the system proxy. WorkBuddy's QQ/WeChat quick-login calls
// localhost.ptlogin2.qq.com / localhost.weixin.qq.com, and a system proxy that
// tunnels those loopback hostnames makes every alternative sign-in fail.
func OpenWorkBuddyLogin(loginURL string) {
	browser := findLoginBrowser()
	if browser == "" {
		openBrowser(loginURL)
		return
	}
	dir, err := config.StateDir()
	if err != nil {
		openBrowser(loginURL)
		return
	}
	profile := filepath.Join(dir, "login-browser")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		openBrowser(loginURL)
		return
	}
	args := []string{
		"--user-data-dir=" + profile,
		"--proxy-server=direct://",
		"--proxy-bypass-list=*",
		"--no-first-run",
		"--no-default-browser-check",
		"--window-size=560,820",
		loginURL,
	}
	cmd := exec.Command(browser, args...)
	if err := cmd.Start(); err != nil {
		openBrowser(loginURL)
	}
}

func findLoginBrowser() string {
	var candidates []string
	add := func(base, rel string) {
		if base != "" {
			candidates = append(candidates, filepath.Join(base, rel))
		}
	}
	add(os.Getenv("ProgramFiles"), `Google\Chrome\Application\chrome.exe`)
	add(os.Getenv("ProgramFiles(x86)"), `Google\Chrome\Application\chrome.exe`)
	add(os.Getenv("LOCALAPPDATA"), `Google\Chrome\Application\chrome.exe`)
	add(os.Getenv("ProgramFiles"), `Microsoft\Edge\Application\msedge.exe`)
	add(os.Getenv("ProgramFiles(x86)"), `Microsoft\Edge\Application\msedge.exe`)
	add(os.Getenv("LOCALAPPDATA"), `Microsoft\Edge\Application\msedge.exe`)
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func openBrowser(u string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	case "darwin":
		cmd = exec.Command("open", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	_ = cmd.Start()
}
