package main

// serve 模式：以 HTTPS 提供网页入口，让手机浏览器也能参与通话。
// 用途是跨网实测（M3）：手机在同一 WiFi 下加载页面后切换到蜂窝网络，
// 信令仍走邀请码（无服务器），媒体经 STUN 打洞 P2P 直连。
//
// 用法: mini-vedio.exe serve [端口]   （默认 9443）

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func runServe(args []string, assets embed.FS) error {
	port := 9443
	if len(args) > 0 {
		if _, err := fmt.Sscanf(args[0], "%d", &port); err != nil || port < 1 || port > 65535 {
			return errors.New("端口需为 1–65535 的数字，例如: mini-vedio serve 9443")
		}
	}

	cert, err := loadOrMakeCert()
	if err != nil {
		return fmt.Errorf("准备证书失败: %w", err)
	}

	sub, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		return fmt.Errorf("读取内嵌前端失败: %w", err)
	}
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(sub)))

	srv := &http.Server{
		Addr:    fmt.Sprintf("0.0.0.0:%d", port),
		Handler: mux,
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		},
	}

	fmt.Println("==========================================")
	fmt.Println(" mini-vedio 网页模式已启动（HTTPS）")
	fmt.Printf("   本机:     https://localhost:%d\n", port)
	for _, ip := range lanIPv4s() {
		fmt.Printf("   局域网:   https://%s:%d\n", ip, port)
	}
	fmt.Println()
	fmt.Println(" 手机跨网测试步骤:")
	fmt.Println(" 1. 手机连到与电脑相同的 WiFi，用 Chrome/Edge 打开上面的局域网地址")
	fmt.Println("    （不要用微信内置浏览器；提示证书风险时选「继续访问」）")
	fmt.Println(" 2. 页面加载完成后，手机关闭 WiFi 改用蜂窝流量（页面保持打开）")
	fmt.Println(" 3. 电脑点「创建新通话」→ 邀请码发给手机 → 手机粘贴后把回复码发回")
	fmt.Println(" 4. 电脑粘贴回复码 → 接通。媒体为 P2P 直连（STUN 打洞）")
	fmt.Println(" 若显示连接失败：多为双方都在对称 NAT 后，需等待中继模式。")
	fmt.Println(" 若手机打不开页面：检查 Windows 防火墙是否放行本程序。")
	fmt.Println(" 按 Ctrl+C 退出")
	fmt.Println("==========================================")

	return srv.ListenAndServeTLS("", "")
}

// loadOrMakeCert 加载（首次时生成并缓存）自签证书；
// 证书固定缓存可保证多次启动指纹一致，手机端提示更有参考性。
func loadOrMakeCert() (tls.Certificate, error) {
	dir, err := configDir()
	if err != nil {
		return tls.Certificate{}, err
	}
	certPath := filepath.Join(dir, "serve-cert.pem")
	keyPath := filepath.Join(dir, "serve-key.pem")

	if cert, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		return cert, nil
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "mini-vedio"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(5, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           append([]net.IP{net.ParseIP("127.0.0.1")}, lanIPv4s()...),
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(certPEM, keyPEM)
}

// lanIPv4s 返回本机所有非回环 IPv4 地址（多网卡时全部列出供用户选择）。
func lanIPv4s() []net.IP {
	var out []net.IP
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				if v4 := ipn.IP.To4(); v4 != nil {
					out = append(out, v4)
				}
			}
		}
	}
	return out
}
