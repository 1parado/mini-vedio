package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"

	"mini-vedio/internal/lan"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// LanService 是暴露给前端的服务：局域网设备列表与信令中继。
// 事件（前端用 @wailsio/runtime 的 Events.On 监听）：
//
//	lan:peers    设备列表变化，data: lan.Peer[]
//	lan:incoming 来电，data: {from, name, callId, sdp}
//	lan:answer   呼叫被接听，data: {callId, sdp}
//	lan:decline  呼叫被拒绝，data: {callId}
//	lan:bye      对方挂断，data: {callId}
//	lan:timeout  呼叫无应答超时，data: {callId}
type LanService struct {
	hub  *lan.Hub
	id   string
	name atomic.Value // string
	busy atomic.Bool
}

// NewLanService 创建服务；hub 在 ServiceStartup 时启动。
func NewLanService(device *Device) *LanService {
	s := &LanService{id: device.ID}
	s.name.Store(device.Name)
	return s
}

// ServiceStartup 实现 wails 服务生命周期接口。
func (s *LanService) ServiceStartup(_ context.Context, _ application.ServiceOptions) error {
	_ = appendDiagnostic("info", "lan.start", "starting UDP discovery")
	hub, err := lan.New(lan.DefaultPort, s.id, s.currentName, s.currentState, s.onEvent)
	if err != nil {
		_ = appendDiagnostic("error", "lan.start.error", err.Error())
		return err
	}
	s.hub = hub
	hub.Start()
	s.emitPeers()
	_ = appendDiagnostic("info", "lan.ready", "UDP discovery started")
	return nil
}

// ServiceShutdown 实现 wails 服务生命周期接口。
func (s *LanService) ServiceShutdown() error {
	_ = appendDiagnostic("info", "lan.stop", "shutting down UDP discovery")
	if s.hub != nil {
		s.hub.Close()
	}
	return nil
}

// Info 返回本机设备信息（前端用于展示与 IP 直连提示）。
func (s *LanService) Info() DeviceInfo {
	ips := make([]string, 0, len(lanIPv4s()))
	for _, ip := range lanIPv4s() {
		ips = append(ips, ip.String())
	}
	return DeviceInfo{ID: s.id, Name: s.currentName(), IPs: ips}
}

// Peers 返回当前在线的局域网设备。
func (s *LanService) Peers() []lan.Peer {
	if s.hub == nil {
		return []lan.Peer{}
	}
	return s.hub.Peers()
}

// ConnectIP 主动向指定 IPv4 发起发现（广播被 AP 隔离/跨网段时的兜底）。
func (s *LanService) ConnectIP(ip string) error {
	_ = appendDiagnostic("info", "lan.connect_ip", "ip="+ip)
	if s.hub == nil {
		return errors.New("局域网服务尚未启动")
	}
	err := s.hub.AddPeerByIP(ip)
	if err != nil {
		_ = appendDiagnostic("warn", "lan.connect_ip.error", err.Error())
	}
	return err
}

// SetName 修改本机设备名并持久化。
func (s *LanService) SetName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 32 {
		return errors.New("设备名需为 1–32 个字符")
	}
	s.name.Store(name)
	_ = appendDiagnostic("info", "device.name", "nameBytes="+fmt.Sprint(len([]rune(name))))
	dir, err := configDir()
	if err != nil {
		return err
	}
	return saveDevice(&Device{ID: s.id, Name: name}, dir+"\\device.json")
}

// SetBusy 更新本机占线状态，随 announce 广播给局域网内设备。
func (s *LanService) SetBusy(busy bool) {
	s.busy.Store(busy)
	if s.hub != nil {
		_ = s.hub.AnnounceNow()
	}
	_ = appendDiagnostic("info", "lan.busy", fmt.Sprintf("busy=%t", busy))
}

// SendOffer 向指定设备发起呼叫（发送 WebRTC offer SDP）。
func (s *LanService) SendOffer(peerID, callID, sdp string) error {
	_ = appendDiagnostic("info", "lan.offer", fmt.Sprintf("peer=%s call=%s sdpBytes=%d", peerID, callID, len(sdp)))
	if s.hub == nil {
		return errors.New("局域网服务尚未启动")
	}
	return s.hub.SendOffer(peerID, callID, sdp)
}

// AcceptCall 接听来电（发送 WebRTC answer SDP）。
func (s *LanService) AcceptCall(peerID, callID, sdp string) error {
	_ = appendDiagnostic("info", "lan.answer", fmt.Sprintf("peer=%s call=%s sdpBytes=%d", peerID, callID, len(sdp)))
	if s.hub == nil {
		return errors.New("局域网服务尚未启动")
	}
	return s.hub.AcceptCall(peerID, callID, sdp)
}

// DeclineCall 拒绝来电。
func (s *LanService) DeclineCall(peerID, callID string) error {
	_ = appendDiagnostic("info", "lan.decline", fmt.Sprintf("peer=%s call=%s", peerID, callID))
	if s.hub == nil {
		return errors.New("局域网服务尚未启动")
	}
	return s.hub.DeclineCall(peerID, callID)
}

// SendBye 通知对方结束通话。
func (s *LanService) SendBye(peerID, callID string) error {
	_ = appendDiagnostic("info", "lan.bye", fmt.Sprintf("peer=%s call=%s", peerID, callID))
	if s.hub == nil {
		return errors.New("局域网服务尚未启动")
	}
	return s.hub.SendBye(peerID, callID)
}

// LogDiagnostic 接收前端阶段日志；调用方不得传入完整 SDP、邀请码或媒体内容。
func (s *LanService) LogDiagnostic(level, event, detail string) error {
	return appendDiagnostic(level, event, detail)
}

// ReadDiagnostics 返回最近的诊断日志，供前端导出。
func (s *LanService) ReadDiagnostics() (string, error) {
	return readDiagnostics()
}

// ClearDiagnostics 清空本机诊断日志。
func (s *LanService) ClearDiagnostics() error {
	return clearDiagnostics()
}

func (s *LanService) currentName() string {
	return s.name.Load().(string)
}

func (s *LanService) currentState() string {
	if s.busy.Load() {
		return "busy"
	}
	return "idle"
}

func (s *LanService) onEvent(ev lan.Event) {
	_ = appendDiagnostic("info", "lan.event", fmt.Sprintf("kind=%s call=%s peer=%s", ev.Kind, ev.CallID, ev.FromID))
	app := application.Get()
	if app == nil {
		return
	}
	switch ev.Kind {
	case lan.EventPeers:
		s.emitPeers()
	case lan.EventIncoming:
		app.Event.Emit("lan:incoming", map[string]any{
			"from": ev.FromID, "name": ev.FromName, "callId": ev.CallID, "sdp": ev.SDP,
		})
	case lan.EventAnswer:
		app.Event.Emit("lan:answer", map[string]any{"callId": ev.CallID, "sdp": ev.SDP})
	case lan.EventDecline:
		app.Event.Emit("lan:decline", map[string]any{"callId": ev.CallID})
	case lan.EventBye:
		app.Event.Emit("lan:bye", map[string]any{"callId": ev.CallID})
	case lan.EventTimeout:
		app.Event.Emit("lan:timeout", map[string]any{"callId": ev.CallID})
	}
}

func (s *LanService) emitPeers() {
	app := application.Get()
	if app == nil || s.hub == nil {
		return
	}
	app.Event.Emit("lan:peers", s.hub.Peers())
}

// DeviceInfo 是本机设备信息。
type DeviceInfo struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	IPs  []string `json:"ips"`
}
