package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	signalDefaultPort = 8787
	signalRoomTTL     = 30 * time.Minute
	signalMaxMessage  = 512 * 1024
)

type signalRoom struct {
	created time.Time
	clients map[*signalClient]struct{}
	queued  []signalResponse
}

type signalClient struct {
	conn *websocket.Conn
	mu   sync.Mutex
	room string
}

type signalRequest struct {
	Action string          `json:"action"`
	Room   string          `json:"room,omitempty"`
	Type   string          `json:"type,omitempty"`
	SDP    string          `json:"sdp,omitempty"`
	ICE    json.RawMessage `json:"ice,omitempty"`
}

type signalResponse struct {
	Type  string          `json:"type"`
	Room  string          `json:"room,omitempty"`
	SDP   string          `json:"sdp,omitempty"`
	ICE   json.RawMessage `json:"ice,omitempty"`
	Error string          `json:"error,omitempty"`
}

type signalServer struct {
	mu    sync.Mutex
	rooms map[string]*signalRoom
}

func runSignal(args []string) error {
	port := signalDefaultPort
	if len(args) > 0 {
		if _, err := fmt.Sscanf(args[0], "%d", &port); err != nil || port < 1 || port > 65535 {
			return errors.New("端口需为 1–65535 的数字，例如: mini-vedio signal 8787")
		}
	}
	server := &signalServer{rooms: make(map[string]*signalRoom)}
	httpServer := &http.Server{Addr: fmt.Sprintf("0.0.0.0:%d", port), Handler: newSignalMux(server), ReadHeaderTimeout: 10 * time.Second}
	tlsCert, err := loadOrMakeCert()
	if err != nil {
		return fmt.Errorf("准备信令服务证书失败: %w", err)
	}
	go server.cleanupLoop()
	fmt.Printf("mini-vedio 信令服务已启动: wss://localhost:%d/ws\n", port)
	for _, ip := range lanIPv4s() {
		fmt.Printf("局域网地址: wss://%s:%d/ws\n", ip, port)
	}
	return httpServer.ListenAndServeTLS(certPEMPath(tlsCert), keyPEMPath(tlsCert))
}

// newSignalMux 独立出来供测试复用（httptest 直接挂 handler，无需真实证书）。
func newSignalMux(server *signalServer) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/ws", server.handle)
	return mux
}

// ListenAndServeTLS 需要文件路径；证书已由 loadOrMakeCert 缓存到配置目录。
func certPEMPath(_ tls.Certificate) string { dir, _ := configDir(); return dir + "\\serve-cert.pem" }
func keyPEMPath(_ tls.Certificate) string  { dir, _ := configDir(); return dir + "\\serve-key.pem" }

func (s *signalServer) handle(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	client := &signalClient{conn: c}
	defer s.disconnect(client)
	ctx := r.Context()
	for {
		readCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		_, data, err := c.Read(readCtx)
		cancel()
		if err != nil {
			return
		}
		if len(data) > signalMaxMessage {
			_ = client.send(ctx, signalResponse{Type: "error", Error: "信令消息过大"})
			return
		}
		var req signalRequest
		if json.Unmarshal(data, &req) != nil {
			_ = client.send(ctx, signalResponse{Type: "error", Error: "信令消息格式错误"})
			continue
		}
		if err := s.route(ctx, client, req); err != nil {
			_ = client.send(ctx, signalResponse{Type: "error", Error: err.Error()})
		}
	}
}

func (s *signalServer) route(ctx context.Context, client *signalClient, req signalRequest) error {
	switch req.Action {
	case "create":
		roomCode, err := newRoomCode()
		if err != nil {
			return err
		}
		s.mu.Lock()
		s.rooms[roomCode] = &signalRoom{created: time.Now(), clients: map[*signalClient]struct{}{client: {}}}
		client.room = roomCode
		s.mu.Unlock()
		return client.send(ctx, signalResponse{Type: "created", Room: roomCode})
	case "join":
		roomCode := strings.ToUpper(strings.TrimSpace(req.Room))
		s.mu.Lock()
		room := s.rooms[roomCode]
		if room == nil {
			s.mu.Unlock()
			return errors.New("房间不存在或已过期")
		}
		if len(room.clients) >= 2 {
			s.mu.Unlock()
			return errors.New("房间已满")
		}
		room.clients[client] = struct{}{}
		client.room = roomCode
		clients := make([]*signalClient, 0, len(room.clients))
		for peer := range room.clients {
			clients = append(clients, peer)
		}
		queued := append([]signalResponse(nil), room.queued...)
		s.mu.Unlock()
		for _, peer := range clients {
			if peer == client {
				continue
			}
			_ = peer.send(ctx, signalResponse{Type: "peer_joined", Room: roomCode})
		}
		if err := client.send(ctx, signalResponse{Type: "joined", Room: roomCode}); err != nil {
			return err
		}
		for _, message := range queued {
			if err := client.send(ctx, message); err != nil {
				return err
			}
		}
		return nil
	case "signal":
		if client.room == "" || (req.Type != "offer" && req.Type != "answer" && req.Type != "ice") {
			return errors.New("无效的信令状态")
		}
		return s.broadcast(ctx, client, signalResponse{Type: req.Type, Room: client.room, SDP: req.SDP, ICE: req.ICE})
	case "bye":
		// 挂断通知：转发给房内对端，让其立即结束通话而不是等 ICE 超时
		if client.room == "" {
			return errors.New("无效的信令状态")
		}
		return s.broadcast(ctx, client, signalResponse{Type: "bye", Room: client.room})
	default:
		return errors.New("未知信令操作")
	}
}

func (s *signalServer) broadcast(ctx context.Context, sender *signalClient, msg signalResponse) error {
	s.mu.Lock()
	room := s.rooms[sender.room]
	var peers []*signalClient
	if room != nil {
		if len(room.queued) >= 32 {
			room.queued = room.queued[len(room.queued)-31:]
		}
		room.queued = append(room.queued, msg)
		for peer := range room.clients {
			if peer != sender {
				peers = append(peers, peer)
			}
		}
	}
	s.mu.Unlock()
	for _, peer := range peers {
		if err := peer.send(ctx, msg); err != nil {
			return err
		}
	}
	return nil
}

func (s *signalServer) disconnect(client *signalClient) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if room := s.rooms[client.room]; room != nil {
		delete(room.clients, client)
		if len(room.clients) == 0 {
			delete(s.rooms, client.room)
		}
	}
	_ = client.conn.CloseNow()
}

func (s *signalServer) cleanupLoop() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for now := range t.C {
		s.mu.Lock()
		for code, room := range s.rooms {
			if now.Sub(room.created) > signalRoomTTL {
				delete(s.rooms, code)
			}
		}
		s.mu.Unlock()
	}
}

func (c *signalClient) send(ctx context.Context, msg signalResponse) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.Write(ctx, websocket.MessageText, data)
}

func newRoomCode() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	var raw [6]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	var code strings.Builder
	for _, b := range raw {
		code.WriteByte(alphabet[int(b)%len(alphabet)])
	}
	return code.String(), nil
}
