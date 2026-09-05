# mini-vedio 发布构建脚本：前端 -> exe -> 体积断言
# 用法: powershell -File scripts\build.ps1 [-SkipFrontend] [-MaxSizeMB 13]
param(
    [switch]$SkipFrontend,
    [int]$MaxSizeMB = 13
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot | Split-Path

if (-not $SkipFrontend) {
    Write-Host '[1/2] 构建前端...' -ForegroundColor Cyan
    npm --prefix "$root\frontend" run build
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
} else {
    Write-Host '[1/2] 跳过前端构建' -ForegroundColor Yellow
}

Write-Host '[2/3] 编译 exe...' -ForegroundColor Cyan
# windowsgui 子系统：双击不弹控制台窗口（serve 模式运行时自建控制台）
go build -trimpath -ldflags "-s -w -H=windowsgui" -o "$root\bin\mini-vedio.exe" "$root"
if ($LASTEXITCODE -ne 0) { throw 'go build 失败' }

# 注入图标/版本/清单（Go 1.26 链接器不嵌入 syso 资源，采用构建后 patch 方式）
# go-winres 以 CWD 解析 winres/ 资源，故固定在仓库根目录执行
Write-Host '[3/3] 注入图标与版本信息...' -ForegroundColor Cyan
Push-Location $root
try {
    go run ./cmd/genicon
    if ($LASTEXITCODE -ne 0) { throw 'genicon 失败' }
    & "$env:USERPROFILE\go\bin\go-winres.exe" patch --no-backup "$root\bin\mini-vedio.exe"
    if ($LASTEXITCODE -ne 0) { throw 'go-winres patch 失败' }
} finally {
    Pop-Location
}

$sizeMB = [math]::Round((Get-Item "$root\bin\mini-vedio.exe").Length / 1MB, 2)
Write-Host ("体积: {0} MB (上限 {1} MB)" -f $sizeMB, $MaxSizeMB)
if ($sizeMB -gt $MaxSizeMB) {
    throw ("体积断言失败: {0} MB > {1} MB，请检查新增依赖" -f $sizeMB, $MaxSizeMB)
}
Write-Host "OK -> bin\mini-vedio.exe" -ForegroundColor Green

# 提醒: 图标/版本信息变更后需手动执行:
#   go run ./cmd/genicon   （由 build/windows/icon.svg 同步重绘 ICO 与 winres PNG）
