//go:build windows

package main

import (
	"os"
	"syscall"
)

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var procAllocConsole = kernel32.NewProc("AllocConsole")

// allocServeConsole 为 serve 模式创建控制台窗口。
// 发布版以 windowsgui 子系统构建（桌面双击无控制台），而 serve 需要打印
// 访问地址与指引，故运行时主动分配一个控制台并重定向标准流。
func allocServeConsole() {
	_, _, _ = procAllocConsole.Call()
	if f, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout = f
		os.Stderr = f
	}
	if f, err := os.OpenFile("CONIN$", os.O_RDONLY, 0); err == nil {
		os.Stdin = f
	}
}
