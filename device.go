package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Device 是本机的持久化设备标识：ID 用于局域网寻址，Name 是展示给对方的名称。
type Device struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// loadDevice 读取（首次运行时创建）设备标识，存储于 %APPDATA%\mini-vedio\device.json。
func loadDevice() (*Device, error) {
	dir, err := configDir()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "device.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		device, err := newDevice()
		if err != nil {
			return nil, err
		}
		if err := saveDevice(device, path); err != nil {
			return nil, err
		}
		return device, nil
	}
	if err != nil {
		return nil, err
	}
	var device *Device
	if err := json.Unmarshal(data, &device); err != nil || device == nil || device.ID == "" {
		// 文件损坏时重新生成，不影响使用
		device, err = newDevice()
		if err != nil {
			return nil, err
		}
		if err := saveDevice(device, path); err != nil {
			return nil, err
		}
	}
	return device, nil
}

func newDevice() (*Device, error) {
	raw := make([]byte, 4)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	id := "mv-" + hex.EncodeToString(raw)
	return &Device{ID: id, Name: defaultName()}, nil
}

func defaultName() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return "本机"
	}
	return host
}

func saveDevice(device *Device, path string) error {
	data, err := json.MarshalIndent(device, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func configDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "mini-vedio")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}
