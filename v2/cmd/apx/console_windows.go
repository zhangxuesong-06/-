//go:build windows

package main

import "syscall"

// initConsole switches the Windows console to UTF-8 so the Chinese status text
// is readable when the gateway is launched from a desktop shortcut.
func initConsole() {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	kernel32.NewProc("SetConsoleOutputCP").Call(65001)
	kernel32.NewProc("SetConsoleCP").Call(65001)
}
