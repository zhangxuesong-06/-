package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"apx2/internal/config"
)

// appCmd runs the gateway in-process and shows the console in a standalone
// browser app window (Chrome/Edge --app): no address bar, no tabs, its own
// taskbar entry. Closing the window shuts the gateway down again.
func appCmd(args []string) error {
	listen := ""
	size := "1180,820"
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--listen":
			if i+1 < len(args) {
				listen = args[i+1]
				i++
			}
		case "--window-size":
			if i+1 < len(args) {
				size = strings.ReplaceAll(args[i+1], "x", ",")
				i++
			}
		}
	}
	if listen == "" {
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		listen = cfg.Listen
	}

	logger := appLogger()
	url := consoleURL(listen)
	logger.Println("app start", url)

	// Already running: do not own the server, just show the window.
	if healthy(url) {
		logger.Println("gateway already running; opening window only")
		return runAppWindow(url, size, logger)
	}

	st, err := buildStack(listen)
	if err != nil {
		logger.Println("build stack:", err)
		return err
	}
	httpSrv := &http.Server{
		Addr:              st.cfg.Listen,
		Handler:           st.srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.ListenAndServe() }()

	deadline := time.Now().Add(10 * time.Second)
	for !healthy(url) {
		select {
		case err := <-errCh:
			logger.Println("listen:", err)
			return err
		default:
		}
		if time.Now().After(deadline) {
			shutdown(httpSrv)
			logger.Println("gateway did not become healthy")
			return fmt.Errorf("网关没有在 10 秒内启动，详见 %s", logPath())
		}
		time.Sleep(150 * time.Millisecond)
	}
	logger.Println("gateway ready, providers:", len(st.rt.Registry().Providers), "models:", len(st.rt.Registry().ModelIDs()))

	err = runAppWindow(url, size, logger)
	shutdown(httpSrv)
	logger.Println("gateway stopped")
	return err
}

func runAppWindow(url, size string, logger *log.Logger) error {
	browser := findBrowser()
	if browser == "" {
		logger.Println("chrome/edge not found; opening default browser (gateway keeps running)")
		openURL(url)
		waitSignal()
		return nil
	}

	dir, err := config.StateDir()
	if err != nil {
		return err
	}
	profile := filepath.Join(dir, "browser")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		return err
	}

	args := []string{
		"--app=" + url,
		"--user-data-dir=" + profile,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-mode",
		"--window-size=" + size,
	}
	logger.Println("launch", browser, strings.Join(args, " "))
	cmd := exec.Command(browser, args...)
	if err := cmd.Start(); err != nil {
		logger.Println("launch failed:", err)
		openURL(url)
		waitSignal()
		return nil
	}
	started := time.Now()
	err = cmd.Wait()
	elapsed := time.Since(started)
	if elapsed < 2*time.Second {
		// The browser handed the request to an already-running instance, so this
		// process is not the window. Keep serving until the user stops it.
		logger.Printf("browser exited after %s (handoff); gateway stays up", elapsed)
		waitSignal()
		return nil
	}
	logger.Println("app window closed after", elapsed.Round(time.Millisecond))
	return nil
}

func findBrowser() string {
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

func appLogger() *log.Logger {
	if _, err := config.StateDir(); err != nil {
		return log.New(os.Stderr, "apx2 ", log.LstdFlags)
	}
	f, err := os.OpenFile(logPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return log.New(os.Stderr, "apx2 ", log.LstdFlags)
	}
	return log.New(f, "apx2 ", log.LstdFlags)
}

func logPath() string {
	dir, err := config.StateDir()
	if err != nil {
		return "apx2-app.log"
	}
	return filepath.Join(dir, "app.log")
}

func shutdown(srv *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func waitSignal() {
	stop, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	<-stop.Done()
}
