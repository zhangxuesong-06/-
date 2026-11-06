// apx2 is a local, magpie-style model gateway: it borrows model channels from
// apps already installed on this machine and re-exposes them behind one local
// OpenAI-compatible endpoint. It does not use magpie at runtime.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"apx2/internal/auth"
	"apx2/internal/config"
	"apx2/internal/gateway"
	"apx2/internal/harness"
	"apx2/internal/router"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "apx:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd = args[0]
		args = args[1:]
	}
	switch cmd {
	case "serve":
		return serve(args)
	case "init":
		return initRegistry(args)
	case "scan":
		return scanCmd()
	case "models":
		return modelsCmd()
	case "providers":
		return providersCmd()
	case "token":
		return tokenCmd()
	case "auth":
		return authCmd(args)
	case "doctor":
		return doctorCmd()
	case "version", "--version", "-v":
		fmt.Println("apx2", gateway.Version)
		return nil
	case "help", "--help", "-h":
		usage()
		return nil
	}
	return fmt.Errorf("未知命令 %q（运行 apx help）", cmd)
}

func usage() {
	fmt.Print(`apx2 · 本地模型网关

用法:
  apx                      启动网关（默认 127.0.0.1:8787）
  apx serve [--listen ADDR]
  apx init [--force]       扫描本机 harness 并生成 ~/.apx2/providers.json
  apx scan                 只扫描，不写配置
  apx providers            列出 provider
  apx models               列出可用模型地址
  apx auth set <id> --key K 写入 apx 自己的凭据文件（不动宿主的凭据）
  apx auth list            列出已保存的凭据（只显示尾部）
  apx token                显示本地 API key
  apx doctor               自检配置/凭据/模型解析

模型地址:
  provider/model           直连某个 provider，如 ollama/qwen2.5:0.5b
  group/model              按路由组顺序/failover，如 auto/deepseek-v4.1-flash
  model                    唯一模型名也可直接用
`)
}

func serve(args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	listen := cfg.Listen
	for i := 0; i < len(args); i++ {
		if args[i] == "--listen" && i+1 < len(args) {
			listen = args[i+1]
			i++
		}
	}
	cfg.Listen = listen
	if err := cfg.Save(); err != nil {
		return err
	}

	reg, err := config.LoadRegistry()
	if err != nil {
		return err
	}
	if len(reg.Providers) == 0 {
		fmt.Println("→ 还没有 provider，先扫描本机并生成配置…")
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		rep := harness.Scan(ctx)
		cancel()
		reg = harness.Seed(rep)
		if err := reg.Save(); err != nil {
			return err
		}
	}

	rt := router.New(reg, cfg.Aliases)
	srv := gateway.New(cfg, rt)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	notes := srv.RefreshModels(ctx)
	cancel()
	for _, n := range notes {
		fmt.Println("  ·", n)
	}

	httpSrv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	reg = rt.Registry()
	fmt.Printf("\napx2 %s\n", gateway.Version)
	fmt.Printf("  端点   http://%s/v1\n", cfg.Listen)
	fmt.Printf("  Key    %s\n", cfg.Token)
	fmt.Printf("  控制台 http://%s/\n", cfg.Listen)
	fmt.Printf("  Provider: %d  模型: %d\n\n", len(reg.Providers), len(reg.ModelIDs()))

	stop, stopCancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopCancel()
	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.ListenAndServe() }()
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-stop.Done():
		fmt.Println("\n正在关闭…")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpSrv.Shutdown(ctx)
	}
}

func initRegistry(args []string) error {
	force := false
	for _, a := range args {
		if a == "--force" || a == "-f" {
			force = true
		}
	}
	if !force {
		if existing, err := config.LoadRegistry(); err == nil && len(existing.Providers) > 0 {
			return fmt.Errorf("%s 已有 %d 个 provider；加 --force 覆盖", config.RegistryPath(), len(existing.Providers))
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	rep := harness.Scan(ctx)
	reg := harness.Seed(rep)
	if err := reg.Save(); err != nil {
		return err
	}
	fmt.Printf("已写入 %s（%d providers / %d groups）\n", config.RegistryPath(), len(reg.Providers), len(reg.Groups))
	for _, p := range reg.Providers {
		fmt.Printf("  · %-12s %-18s %s\n", p.ID, p.Protocol, p.BaseURL)
	}
	return nil
}

func scanCmd() error {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	rep := harness.Scan(ctx)
	for _, f := range rep.Findings {
		state := "缺凭据"
		if f.Available {
			state = "可用"
		}
		if f.Healthy != nil && !*f.Healthy {
			state += " / 网络不可达"
		}
		fmt.Printf("%-18s %-28s %s\n", f.ID, f.Name, state)
		fmt.Printf("  %s\n", f.Detail)
		if len(f.Models) > 0 {
			fmt.Printf("  models: %s\n", strings.Join(f.Models, ", "))
		}
		if f.Note != "" {
			fmt.Printf("  note: %s\n", f.Note)
		}
	}
	return nil
}

func modelsCmd() error {
	reg, err := config.LoadRegistry()
	if err != nil {
		return err
	}
	ids := reg.ModelIDs()
	if len(ids) == 0 {
		fmt.Println("没有模型；先运行 apx init")
		return nil
	}
	sort.Strings(ids)
	for _, id := range ids {
		fmt.Println(id)
	}
	return nil
}

func providersCmd() error {
	reg, err := config.LoadRegistry()
	if err != nil {
		return err
	}
	if len(reg.Providers) == 0 {
		fmt.Println("没有 provider；先运行 apx init")
		return nil
	}
	for _, p := range reg.Providers {
		authKind := p.Auth.Type
		if authKind == "" {
			authKind = "none"
		}
		fmt.Printf("%-12s %-18s %-28s auth=%-16s models=%d\n", p.ID, p.Protocol, p.BaseURL, authKind, len(p.Models))
		if p.Notes != "" {
			fmt.Printf("  %s\n", p.Notes)
		}
	}
	return nil
}

func tokenCmd() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	fmt.Println(cfg.Token)
	return nil
}

func authCmd(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("用法: apx auth set <provider> --key <key> | apx auth list")
	}
	switch args[0] {
	case "set":
		if len(args) < 2 {
			return fmt.Errorf("缺少 provider id")
		}
		provider := args[1]
		key := ""
		field := "key"
		for i := 2; i < len(args); i++ {
			switch args[i] {
			case "--key", "-k":
				if i+1 < len(args) {
					key = args[i+1]
					i++
				}
			case "--field":
				if i+1 < len(args) {
					field = args[i+1]
					i++
				}
			}
		}
		if key == "" {
			// Allow piping the key so it never appears in shell history.
			var buf strings.Builder
			if _, err := fmt.Fscanln(os.Stdin, &buf); err == nil && buf.Len() > 0 {
				key = strings.TrimSpace(buf.String())
			}
		}
		if key == "" {
			return fmt.Errorf("缺少 --key（或用管道从 stdin 读入）")
		}
		if err := auth.SetSecret(provider, field, key); err != nil {
			return err
		}
		fmt.Printf("已写入 %s 的 %s（尾部 %s）到 %s\n", provider, field, tail(key, 4), config.CredentialsPath())
		return nil
	case "list":
		raw, err := os.ReadFile(config.CredentialsPath())
		if err != nil {
			fmt.Println("还没有保存任何凭据")
			return nil
		}
		fmt.Println(string(raw))
		return nil
	}
	return fmt.Errorf("未知 auth 子命令 %q", args[0])
}

func doctorCmd() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	reg, err := config.LoadRegistry()
	if err != nil {
		return err
	}
	fmt.Println("config  ", config.ConfigPath())
	fmt.Println("registry", config.RegistryPath())
	fmt.Println("creds   ", config.CredentialsPath())
	fmt.Println("listen  ", cfg.Listen)
	fmt.Println("token   ", config.MaskToken(cfg.Token))
	fmt.Println("providers", len(reg.Providers), "models", len(reg.ModelIDs()))
	for _, p := range reg.Providers {
		headers, err := authFor(p)(context.Background())
		if err != nil {
			fmt.Printf("  ✗ %-12s %v\n", p.ID, err)
			continue
		}
		var names []string
		for k := range headers {
			names = append(names, k)
		}
		sort.Strings(names)
		fmt.Printf("  ✓ %-12s auth=%s headers=%s\n", p.ID, firstNonEmpty(p.Auth.Type, "none"), strings.Join(names, ","))
	}
	rt := router.New(reg, cfg.Aliases)
	for _, id := range reg.ModelIDs() {
		if _, err := rt.Resolve(id); err != nil {
			fmt.Printf("  ✗ resolve %s: %v\n", id, err)
		}
	}
	return nil
}

func authFor(p config.Provider) auth.Resolver { return auth.Build(p) }

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
