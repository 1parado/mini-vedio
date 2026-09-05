// genicon 生成 mini-vedio 的 Windows 图标（build/windows/icon.ico）。
//
// 图标几何与 build/windows/icon.svg 完全一致（黑色圆角方块 + 白色摄像机），
// 用逐像素超采样光栅化，避免引入 SVG 渲染依赖。仅构建期使用，
// 在仓库根目录执行：go run ./cmd/genicon
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"
)

const (
	canvas       = 512.0
	cornerRadius = 115.0
	superSample  = 3 // 每像素 3×3 超采样抗锯齿
)

// 形状与 icon.svg 对齐（512 坐标系）：背景 = 整块圆角方块，字形 = 摄像机机身 + 镜头三角
var bodyRect = rect{43, 128, 299, 256, 43}
var lensTriangle = [3][2]float64{{341, 256}, {469, 171}, {469, 341}}

type rect struct{ x, y, w, h, r float64 }

func (r rect) contains(x, y float64) bool {
	if x < r.x || y < r.y || x > r.x+r.w || y > r.y+r.h {
		return false
	}
	cx := math.Max(r.x+r.r, math.Min(x, r.x+r.w-r.r))
	cy := math.Max(r.y+r.r, math.Min(y, r.y+r.h-r.r))
	dx, dy := x-cx, y-cy
	return dx*dx+dy*dy <= r.r*r.r
}

func roundRectContains(x, y float64) bool {
	return inRoundRect(x, y, 0, 0, canvas, canvas, cornerRadius)
}

func inRoundRect(x, y, rx, ry, w, h, r float64) bool {
	if x < rx || y < ry || x > rx+w || y > ry+h {
		return false
	}
	cx := math.Max(rx+r, math.Min(x, rx+w-r))
	cy := math.Max(ry+r, math.Min(y, ry+h-r))
	dx, dy := x-cx, y-cy
	return dx*dx+dy*dy <= r*r
}

func triangleContains(x, y float64) bool {
	sign := 0.0
	for i := 0; i < 3; i++ {
		a, b := lensTriangle[i], lensTriangle[(i+1)%3]
		cross := (b[0]-a[0])*(y-a[1]) - (b[1]-a[1])*(x-a[0])
		if cross == 0 {
			continue
		}
		s := 1.0
		if cross < 0 {
			s = -1
		}
		if sign == 0 {
			sign = s
		} else if s != sign {
			return false
		}
	}
	return true
}

func inGlyph(x, y float64) bool {
	return bodyRect.contains(x, y) || triangleContains(x, y)
}

// render 把图标光栅化为 size×size 的直通透明像素。
func render(size int) *image.NRGBA {
	return renderPWA(size, false)
}

// renderPWA 在 render 基础上支持 maskable 变体：
// 背景铺满整个画布（Android 自行裁圆角），字形向中心缩小到 85% 以满足安全区。
func renderPWA(size int, maskable bool) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	scale := canvas / float64(size)
	n := float64(superSample * superSample)
	glyphScale, bgFull := 1.0, false
	if maskable {
		glyphScale, bgFull = 0.85, true
	}
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			cov, white := 0.0, 0.0
			for sy := 0; sy < superSample; sy++ {
				for sx := 0; sx < superSample; sx++ {
					x := (float64(px) + (float64(sx)+0.5)/superSample) * scale
					y := (float64(py) + (float64(sy)+0.5)/superSample) * scale
					inside := roundRectContains(x, y)
					if bgFull {
						inside = x >= 0 && x < canvas && y >= 0 && y < canvas
					}
					if !inside {
						continue
					}
					cov++
					gx, gy := x, y
					if glyphScale != 1.0 {
						gx = canvas/2 + (x-canvas/2)/glyphScale
						gy = canvas/2 + (y-canvas/2)/glyphScale
					}
					if inGlyph(gx, gy) {
						white++
					}
				}
			}
			if cov == 0 {
				continue // 圆角外保持透明
			}
			wf := white / cov
			v := uint8(math.Round(17 + (255-17)*wf))
			img.SetNRGBA(px, py, color.NRGBA{R: v, G: v, B: v, A: uint8(math.Round(cov / n * 255))})
		}
	}
	return img
}

func pngBytes(img *image.NRGBA) []byte {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		log.Fatalf("编码 PNG 失败: %v", err)
	}
	return buf.Bytes()
}

// writeICO 按 ICO 容器格式写入多个 PNG 帧（Vista+ 支持 PNG 帧）。
func writeICO(path string, sizes []int, frames map[int][]byte) error {
	var buf bytes.Buffer
	buf.Write([]byte{0, 0, 1, 0, byte(len(sizes)), 0})
	offset := 6 + 16*len(sizes)
	for _, s := range sizes {
		dim := byte(s)
		if s == 256 {
			dim = 0
		}
		buf.Write([]byte{dim, dim, 0, 0})
		_ = binary.Write(&buf, binary.LittleEndian, uint16(1))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(32))
		_ = binary.Write(&buf, binary.LittleEndian, uint32(len(frames[s])))
		_ = binary.Write(&buf, binary.LittleEndian, uint32(offset))
		offset += len(frames[s])
	}
	for _, s := range sizes {
		buf.Write(frames[s])
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func main() {
	out, err := filepath.Abs(filepath.Join("build", "windows", "icon.ico"))
	if err != nil {
		log.Fatal(err)
	}
	sizes := []int{16, 24, 32, 48, 64, 128, 256}
	frames := make(map[int][]byte, len(sizes))
	for _, s := range sizes {
		frames[s] = pngBytes(render(s))
		fmt.Printf("已渲染 %dx%d\n", s, s)
	}
	if err := writeICO(out, sizes, frames); err != nil {
		log.Fatalf("写入 ICO 失败: %v", err)
	}
	// 同时导出 PNG 到 winres/（go-winres patch 以 winres/ 为根解析资源路径）
	// icon.png=256 主图标，icon16.png=16 小尺寸原绘（任务栏/标题栏更清晰）
	writePng := func(name string, size int) {
		p, err := filepath.Abs(filepath.Join("winres", name))
		if err != nil {
			log.Fatal(err)
		}
		if err := os.WriteFile(p, frames[size], 0o644); err != nil {
			log.Fatalf("写入 %s 失败: %v", name, err)
		}
	}
	writePng("icon.png", 256)
	writePng("icon16.png", 16)

	// PWA/安卓图标：写入 frontend/public/icons/，随前端构建进入 dist 并被 go:embed 内嵌
	pwaDir, err := filepath.Abs(filepath.Join("frontend", "public", "icons"))
	if err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(pwaDir, 0o755); err != nil {
		log.Fatalf("创建 PWA 图标目录失败: %v", err)
	}
	pwaIcons := []struct {
		name     string
		size     int
		maskable bool
	}{
		{"icon-192.png", 192, false},
		{"icon-512.png", 512, false},
		{"maskable-192.png", 192, true},
		{"maskable-512.png", 512, true},
		{"apple-touch-icon.png", 180, true},
	}
	for _, ic := range pwaIcons {
		p := filepath.Join(pwaDir, ic.name)
		if err := os.WriteFile(p, pngBytes(renderPWA(ic.size, ic.maskable)), 0o644); err != nil {
			log.Fatalf("写入 %s 失败: %v", ic.name, err)
		}
		fmt.Printf("已生成 PWA 图标 %s\n", p)
	}
	fmt.Println("图标已生成:", out)
}
