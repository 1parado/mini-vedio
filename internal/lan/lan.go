// Package lan 实现局域网内的设备发现与 WebRTC 信令中继。
//
// 协议设计（UDP + JSON）：
//   - 广播套接字绑定固定端口（SO_REUSEADDR + SO_BROADCAST），只用于广播 announce；
//   - 信令套接字绑定临时端口，承载 offer/answer/bye/decline 的单播；
//     这样同一台机器可以同时运行多个实例（例如调试），互不抢端口；
//   - announce 携带本实例的信令端口，对端据此回包；
//   - 此处只搬运 SDP 文本，媒体始终由 WebRTC 的 DTLS-SRTP 端到端加密直连。
package lan

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"sync"
	"syscall"
	"time"
)

const (
	// DefaultPort 是发现广播使用的固定 UDP 端口。
	DefaultPort = 47824

	announceInterval = 2 * time.Second
	peerTimeout      = 6 * time.Second
	retryInterval    = 2 * time.Second
	offerMaxRetries  = 15
	writeTimeout     = 2 * time.Second
	maxCallIDBytes   = 128
	maxSDPBytes      = 64 * 1024
	cacheTTL         = 2 * time.Minute

	appID  = "mini-vedio"
	protoV = 1
)

// soBroadcast 是 Windows 的 SOL_SOCKET/SO_BROADCAST（Go 的 syscall 包未定义该常量）。
const soBroadcast = 0x20

// 消息类型。
const (
	KindAnnounce = "announce"
	KindOffer    = "offer"
	KindAnswer   = "answer"
	KindBye      = "bye"
	KindDecline  = "decline"
)

// 事件的 Kind 取值（回调给上层，由上层转发到前端）。
const (
	EventPeers    = "peers"    // Peers 字段有效：设备列表变化
	EventIncoming = "incoming" // 对方来电：FromID/FromName/CallID/SDP
	EventAnswer   = "answer"   // 我方发起的呼叫收到回复：CallID/SDP
	EventDecline  = "decline"  // 对方拒绝了呼叫：CallID
	EventBye      = "bye"      // 对方挂断：CallID
	EventTimeout  = "timeout"  // 呼叫无应答超时：CallID
)

// Message 是 UDP 上传输的信令报文。
type Message struct {
	V       int    `json:"v"`
	App     string `json:"app"`
	Type    string `json:"type"`
	ID      string `json:"id"`
	Name    string `json:"name,omitempty"`
	SigPort int    `json:"sigPort,omitempty"`
	State   string `json:"state,omitempty"` // announce 携带：idle | busy
	CallID  string `json:"callId,omitempty"`
	SDP     string `json:"sdp,omitempty"`
}

// Peer 是前端可见的设备信息。
type Peer struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	State string `json:"state"`
}

// Event 是 Hub 向上层推送的通知。
type Event struct {
	Kind     string
	Peers    []Peer
	FromID   string
	FromName string
	CallID   string
	SDP      string
}

type peerEntry struct {
	peer Peer
	sig  *net.UDPAddr
	seen time.Time
}

type pendingCall struct {
	toID string
	sdp  string
	done chan struct{}
	once sync.Once
}

type cachedAnswer struct {
	sdp  string
	seen time.Time
}

func (p *pendingCall) finish() { p.once.Do(func() { close(p.done) }) }

// Hub 维护局域网内的设备表并中继信令。并发安全。
type Hub struct {
	port      int
	selfID    string
	selfName  func() string
	selfState func() string
	onEvent   func(Event)

	bcast *net.UDPConn
	sig   *net.UDPConn

	mu      sync.Mutex
	peers   map[string]*peerEntry
	answers map[string]cachedAnswer // callID -> 我方已发出的 answer（应对重复 offer）
	pending map[string]*pendingCall
	offers  map[string]time.Time // 已通知前端的来电（避免重复弹窗）
	stopCh  chan struct{}
	once    sync.Once
	wg      sync.WaitGroup
}

// New 创建 Hub；selfName/selfState 为取值函数（状态可随通话动态变化），
// onEvent 在 Hub 内部协程中被调用，需保证非阻塞。
func New(port int, selfID string, selfName, selfState func() string, onEvent func(Event)) (*Hub, error) {
	if port <= 0 {
		port = DefaultPort
	}
	bc, err := listenBroadcast(port)
	if err != nil {
		return nil, fmt.Errorf("绑定广播端口 %d 失败: %w", port, err)
	}
	sc, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		_ = bc.Close()
		return nil, fmt.Errorf("绑定信令端口失败: %w", err)
	}
	return &Hub{
		port:      port,
		selfID:    selfID,
		selfName:  selfName,
		selfState: selfState,
		onEvent:   onEvent,
		bcast:     bc,
		sig:       sc,
		peers:     make(map[string]*peerEntry),
		answers:   make(map[string]cachedAnswer),
		pending:   make(map[string]*pendingCall),
		offers:    make(map[string]time.Time),
		stopCh:    make(chan struct{}),
	}, nil
}

// listenBroadcast 绑定固定端口用于收发广播。
// SO_REUSEADDR 允许多实例同端口共存（Windows 上广播会送达所有套接字），
// SO_BROADCAST 允许发送到 255.255.255.255。
func listenBroadcast(port int) (*net.UDPConn, error) {
	cfg := net.ListenConfig{
		Control: func(_, _ string, c syscall.RawConn) error {
			var ctrlErr error
			err := c.Control(func(fd uintptr) {
				if e := syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); e != nil {
					ctrlErr = e
					return
				}
				if e := syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, soBroadcast, 1); e != nil {
					ctrlErr = e
				}
			})
			if err != nil {
				return err
			}
			return ctrlErr
		},
	}
	conn, err := cfg.ListenPacket(context.Background(), "udp4", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		return nil, err
	}
	return conn.(*net.UDPConn), nil
}

// Start 启动收发与维护协程。
func (h *Hub) Start() {
	h.wg.Add(3)
	go h.readLoop(h.bcast)
	go h.readLoop(h.sig)
	go h.maintainLoop()
	_ = h.sendBroadcast()
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		t := time.NewTicker(announceInterval)
		defer t.Stop()
		for {
			select {
			case <-h.stopCh:
				return
			case <-t.C:
				_ = h.sendBroadcast()
			}
		}
	}()
}

// AddPeerByIP 向指定 IPv4 的发现端口直接单播 announce。
// 广播被路由器 AP 隔离/防火墙拦截时的兜底手段；对端收到后会单播回应。
func (h *Hub) AddPeerByIP(ip string) error {
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.To4() == nil {
		return errors.New("请输入有效的 IPv4 地址")
	}
	return h.sendTo(&net.UDPAddr{IP: parsed.To4(), Port: DefaultPort}, h.message(KindAnnounce, "", ""))
}

// AnnounceNow 立即广播一次本机 announce（状态变化时调用）。
func (h *Hub) AnnounceNow() error {
	return h.sendBroadcast()
}

// Close 停止 Hub 并释放端口。
func (h *Hub) Close() {
	h.once.Do(func() { close(h.stopCh) })
	_ = h.bcast.Close()
	_ = h.sig.Close()
	h.wg.Wait()
}

// Peers 返回当前在线设备快照（不含本机）。
func (h *Hub) Peers() []Peer {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Peer, 0, len(h.peers))
	for _, e := range h.peers {
		out = append(out, e.peer)
	}
	return out
}

// SendOffer 以我方为发起方向指定设备发送 offer，直到收到 answer 或超时。
// 成功后 answer 通过 EventAnswer 事件异步送达。
func (h *Hub) SendOffer(peerID, callID, sdp string) error {
	if !validCall(callID) || !validSDP(sdp) {
		return errors.New("callId 与 sdp 不能为空")
	}
	h.mu.Lock()
	peer, ok := h.peers[peerID]
	h.mu.Unlock()
	if !ok {
		return errors.New("设备已离线")
	}
	pc := &pendingCall{toID: peerID, sdp: sdp, done: make(chan struct{})}
	h.mu.Lock()
	if _, exists := h.pending[callID]; exists {
		h.mu.Unlock()
		return errors.New("该呼叫已在进行中")
	}
	h.pending[callID] = pc
	h.mu.Unlock()
	if err := h.sendTo(peer.sig, h.message(KindOffer, callID, sdp)); err != nil {
		h.finishPending(callID)
		return err
	}
	h.wg.Add(1)
	go h.retryOffer(callID, pc)
	return nil
}

// AcceptCall 回复对方发起的 offer（发送 answer）。
func (h *Hub) AcceptCall(peerID, callID, sdp string) error {
	if !validCall(callID) || !validSDP(sdp) {
		return errors.New("callId 与 sdp 不能为空")
	}
	h.mu.Lock()
	peer, ok := h.peers[peerID]
	if ok {
		h.answers[callID] = cachedAnswer{sdp: sdp, seen: time.Now()}
	}
	h.mu.Unlock()
	if !ok {
		return errors.New("设备已离线")
	}
	if err := h.sendTo(peer.sig, h.message(KindAnswer, callID, sdp)); err != nil {
		h.mu.Lock()
		delete(h.answers, callID)
		h.mu.Unlock()
		return err
	}
	return nil
}

// DeclineCall 拒绝对方的来电。
func (h *Hub) DeclineCall(peerID, callID string) error {
	if !validCall(callID) {
		return errors.New("callId 不能为空")
	}
	h.mu.Lock()
	peer, ok := h.peers[peerID]
	delete(h.answers, callID)
	h.mu.Unlock()
	if !ok {
		return errors.New("设备已离线")
	}
	return h.sendTo(peer.sig, h.message(KindDecline, callID, ""))
}

// SendBye 通知对方结束通话。
func (h *Hub) SendBye(peerID, callID string) error {
	if !validCall(callID) {
		return errors.New("callId 不能为空")
	}
	h.mu.Lock()
	peer, ok := h.peers[peerID]
	h.mu.Unlock()
	if !ok {
		return errors.New("设备已离线")
	}
	return h.sendTo(peer.sig, h.message(KindBye, callID, ""))
}

func (h *Hub) retryOffer(callID string, pc *pendingCall) {
	defer h.wg.Done()
	ticker := time.NewTicker(retryInterval)
	defer ticker.Stop()
	for i := 0; ; i++ {
		select {
		case <-h.stopCh:
			return
		case <-pc.done:
			return
		case <-ticker.C:
		}
		if i >= offerMaxRetries {
			h.finishPending(callID)
			h.emit(Event{Kind: EventTimeout, CallID: callID})
			return
		}
		h.mu.Lock()
		peer, ok := h.peers[pc.toID]
		h.mu.Unlock()
		if !ok {
			h.finishPending(callID)
			h.emit(Event{Kind: EventTimeout, CallID: callID})
			return
		}
		_ = h.sendTo(peer.sig, h.message(KindOffer, callID, pc.sdp))
	}
}

func (h *Hub) finishPending(callID string) {
	h.mu.Lock()
	pc := h.pending[callID]
	delete(h.pending, callID)
	h.mu.Unlock()
	if pc != nil {
		pc.finish()
	}
}

func (h *Hub) message(kind, callID, sdp string) Message {
	return Message{
		V: protoV, App: appID, Type: kind,
		ID: h.selfID, Name: h.selfName(), SigPort: h.sigPort(),
		State: h.selfState(), CallID: callID, SDP: sdp,
	}
}

func (h *Hub) sigPort() int {
	return h.sig.LocalAddr().(*net.UDPAddr).Port
}

// broadcastAddrs 返回本机所有 IPv4 网段的定向广播地址，并附加受限广播地址。
// 逐网卡定向广播可避免多网卡/VPN 环境下 255.255.255.255 从默认路由网卡发错出口。
func broadcastAddrs() []*net.UDPAddr {
	addrs := []*net.UDPAddr{{IP: net.IPv4bcast, Port: DefaultPort}}
	seen := map[string]bool{net.IPv4bcast.String(): true}
	ifaces, err := net.Interfaces()
	if err != nil {
		return addrs
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		ifcAddrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range ifcAddrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			v4 := ipn.IP.To4()
			if v4 == nil || len(ipn.Mask) != 4 {
				continue
			}
			b := make(net.IP, 4)
			for i := 0; i < 4; i++ {
				b[i] = v4[i] | ^ipn.Mask[i]
			}
			if !seen[b.String()] {
				seen[b.String()] = true
				addrs = append(addrs, &net.UDPAddr{IP: b, Port: DefaultPort})
			}
		}
	}
	return addrs
}

func (h *Hub) sendBroadcast() error {
	data, err := json.Marshal(h.message(KindAnnounce, "", ""))
	if err != nil {
		return err
	}
	var firstErr error
	for _, addr := range broadcastAddrs() {
		if err := h.write(h.bcast, addr, data); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (h *Hub) sendTo(addr *net.UDPAddr, m Message) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return h.write(h.sig, addr, data)
}

func (h *Hub) write(conn *net.UDPConn, addr *net.UDPAddr, data []byte) error {
	_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	_, err := conn.WriteToUDP(data, addr)
	return err
}

func (h *Hub) readLoop(conn *net.UDPConn) {
	defer h.wg.Done()
	buf := make([]byte, 64*1024)
	for {
		n, raddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-h.stopCh:
				return
			default:
			}
			if errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		var m Message
		if err := json.Unmarshal(buf[:n], &m); err != nil {
			continue
		}
		h.handle(&m, raddr)
	}
}

func (h *Hub) handle(m *Message, raddr *net.UDPAddr) {
	if m.App != appID || m.V != protoV || m.ID == "" || m.ID == h.selfID {
		return
	}
	switch m.Type {
	case KindAnnounce:
		isNew := h.upsertPeer(m, raddr)
		// 每次收到 announce 都单播回应一次：双向发现不依赖广播回环，
		// 单个方向的包丢失也能在下一轮心跳收敛
		sig := &net.UDPAddr{IP: raddr.IP, Port: m.SigPort}
		_ = h.sendTo(sig, h.message(KindAnnounce, "", ""))
		if isNew {
			h.emit(Event{Kind: EventPeers, Peers: h.Peers()})
		}
	case KindOffer:
		h.upsertPeer(m, raddr)
		h.handleOffer(m, raddr)
	case KindAnswer:
		if !validCall(m.CallID) || !validSDP(m.SDP) {
			return
		}
		h.upsertPeer(m, raddr)
		h.mu.Lock()
		pc := h.pending[m.CallID]
		if pc != nil && pc.toID == m.ID {
			delete(h.pending, m.CallID)
		}
		h.mu.Unlock()
		if pc != nil {
			pc.finish()
			h.emit(Event{Kind: EventAnswer, CallID: m.CallID, SDP: m.SDP})
		}
	case KindBye:
		if !validCall(m.CallID) {
			return
		}
		h.finishPending(m.CallID)
		h.mu.Lock()
		delete(h.answers, m.CallID)
		delete(h.offers, m.CallID)
		h.mu.Unlock()
		h.emit(Event{Kind: EventBye, CallID: m.CallID})
	case KindDecline:
		if !validCall(m.CallID) {
			return
		}
		h.finishPending(m.CallID)
		h.mu.Lock()
		delete(h.answers, m.CallID)
		h.mu.Unlock()
		h.emit(Event{Kind: EventDecline, CallID: m.CallID})
	}
}

func (h *Hub) handleOffer(m *Message, raddr *net.UDPAddr) {
	if !validCall(m.CallID) || !validSDP(m.SDP) || m.SigPort <= 0 || m.SigPort > 65535 {
		return
	}
	sig := &net.UDPAddr{IP: raddr.IP, Port: m.SigPort}
	h.mu.Lock()
	if answer, ok := h.answers[m.CallID]; ok {
		answer.seen = time.Now()
		h.answers[m.CallID] = answer
		// 重复收到同一呼叫的 offer（answer 可能丢包）：重发已缓存的 answer
		h.mu.Unlock()
		_ = h.sendTo(sig, h.message(KindAnswer, m.CallID, answer.sdp))
		return
	}
	if _, notified := h.offers[m.CallID]; notified {
		h.mu.Unlock()
		return
	}
	h.offers[m.CallID] = time.Now()
	h.mu.Unlock()
	h.emit(Event{Kind: EventIncoming, FromID: m.ID, FromName: m.Name, CallID: m.CallID, SDP: m.SDP})
}

// upsertPeer 更新设备表，返回是否为新设备。
func (h *Hub) upsertPeer(m *Message, raddr *net.UDPAddr) bool {
	if m.SigPort <= 0 || m.SigPort > 65535 {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	existing, ok := h.peers[m.ID]
	state := m.State
	if state == "" {
		state = "idle"
	}
	if ok {
		existing.peer.Name = m.Name
		existing.peer.State = state
		existing.seen = time.Now()
		if m.SigPort > 0 {
			existing.sig = &net.UDPAddr{IP: raddr.IP, Port: m.SigPort}
		}
		return false
	}
	h.peers[m.ID] = &peerEntry{
		peer: Peer{ID: m.ID, Name: m.Name, State: state},
		sig:  &net.UDPAddr{IP: raddr.IP, Port: m.SigPort},
		seen: time.Now(),
	}
	return true
}

func (h *Hub) maintainLoop() {
	defer h.wg.Done()
	ticker := time.NewTicker(announceInterval)
	defer ticker.Stop()
	for {
		select {
		case <-h.stopCh:
			return
		case <-ticker.C:
			changed := h.prunePeers()
			if changed {
				h.emit(Event{Kind: EventPeers, Peers: h.Peers()})
			}
		}
	}
}

func (h *Hub) prunePeers() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	changed := false
	for id, e := range h.peers {
		if time.Since(e.seen) > peerTimeout {
			delete(h.peers, id)
			changed = true
		}
	}
	for callID, seen := range h.offers {
		if time.Since(seen) > cacheTTL {
			delete(h.offers, callID)
		}
	}
	for callID, answer := range h.answers {
		if time.Since(answer.seen) > cacheTTL {
			delete(h.answers, callID)
		}
	}
	return changed
}

func validCall(callID string) bool {
	return callID != "" && len(callID) <= maxCallIDBytes
}

func validSDP(sdp string) bool {
	return sdp != "" && len(sdp) <= maxSDPBytes
}

func (h *Hub) emit(ev Event) {
	defer func() {
		// 上层回调异常不能拖垮 Hub
		if r := recover(); r != nil {
			log.Printf("lan: 事件回调异常: %v", r)
		}
	}()
	h.onEvent(ev)
}
