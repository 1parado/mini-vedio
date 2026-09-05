// mini-vedio：点对点加密音视频通话（Windows 桌面端）。
// 媒体由 WebView2 内置 WebRTC 端到端加密直连；Go 侧只做窗口壳、
// 局域网发现与信令中继，详见 AGENTS.md。
package main

import (
	"embed"
	"log"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

// 应用图标（PNG）：注入 application.Options.Icon 作为 Wails 加载资源失败时的回退，
// 同时作为系统托盘图标。源文件 winres/icon.png，由 cmd/genicon 生成。
//
//go:embed winres/icon.png
var appIcon []byte

func main() {
	// serve 子命令：网页模式（手机浏览器入口，用于跨网测试），不启动桌面窗口
	if len(os.Args) > 1 && os.Args[1] == "serve" {
		allocServeConsole()
		if err := runServe(os.Args[2:], assets); err != nil {
			log.Fatal(err)
		}
		return
	}

	device, err := loadDevice()
	if err != nil {
		log.Fatalf("初始化设备标识失败: %v", err)
	}

	lanService := NewLanService(device)

	app := application.New(application.Options{
		Name:        "mini-vedio",
		Description: "极简的点对点加密音视频通话",
		Services: []application.Service{
			application.NewService(lanService),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		// 应用级图标：Wails 在 Windows 上先尝试从 exe 资源加载 RT_GROUP_ICON ID=3，
		// 失败时回退到此 PNG。winres.json 已把图标注册为 ID=3，二者互为兜底。
		Icon: appIcon,
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "mini-vedio",
		Width:            1200,
		Height:           760,
		MinWidth:         480,
		MinHeight:        600,
		BackgroundColour: application.NewRGB(255, 255, 255),
		URL:              "/",
		// 能力请求只可能来自应用自身的内嵌页面，摄像头/麦克风/剪贴板静默放行
		// （剪贴板用于"复制邀请码后切回窗口自动检测加入"的体验）
		Permissions: map[application.PermissionType]application.Permission{
			application.PermissionMicrophone:    application.PermissionAllow,
			application.PermissionCamera:        application.PermissionAllow,
			application.PermissionClipboardRead: application.PermissionAllow,
		},
		// 发布加固：关闭 devtools 与默认右键菜单
		DevToolsEnabled:            false,
		DefaultContextMenuDisabled: true,
	})

	// 关闭窗口不退出进程：改为隐藏到托盘。这是局域网来电的前提——
	// 进程一旦退出，UDP 发现与来电监听立即停止，对方根本呼不进来。
	// 真正退出由托盘菜单"退出"触发 app.Quit()。
	window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		window.Hide()
		e.Cancel()
	})

	// 系统托盘：关窗后的常驻入口，显示主界面与退出应用
	tray := app.SystemTray.New()
	tray.SetIcon(appIcon)
	tray.SetTooltip("mini-vedio - 加密通话")
	trayMenu := app.NewMenu()
	trayMenu.Add("显示主界面").OnClick(func(ctx *application.Context) {
		window.Show()
	})
	trayMenu.Add("退出").OnClick(func(ctx *application.Context) {
		app.Quit()
	})
	tray.SetMenu(trayMenu)
	tray.OnClick(func() {
		window.Show()
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
