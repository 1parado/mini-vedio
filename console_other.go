//go:build !windows

package main

// allocServeConsole 在非 Windows 平台为空实现（进程本就带终端）。
func allocServeConsole() {}
