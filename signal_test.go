package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

func TestNewRoomCode(t *testing.T) {
	pattern := regexp.MustCompile(`^[A-Z2-9]{6}$`)
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		code, err := newRoomCode()
		if err != nil {
			t.Fatal(err)
		}
		if !pattern.MatchString(code) || seen[code] {
			t.Fatalf("invalid or duplicate room code: %q", code)
		}
		seen[code] = true
	}
}

// bye 必须转发给房内对端（挂断通知），且未进房时被拒绝。
func TestSignalBye(t *testing.T) {
	server := &signalServer{rooms: make(map[string]*signalRoom)}
	srv := httptest.NewServer(newSignalMux(server))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	ctx := context.Background()
	dial := func() *websocket.Conn {
		c, _, err := websocket.Dial(ctx, wsURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	// 未进房直接发 bye：应返回 error 而非崩溃
	caller := dial()
	defer caller.CloseNow()
	req, _ := json.Marshal(signalRequest{Action: "bye"})
	if err := caller.Write(ctx, websocket.MessageText, req); err != nil {
		t.Fatal(err)
	}
	_, data, err := caller.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var resp signalResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Type != "error" || resp.Error == "" {
		t.Fatalf("expected error response for unjoined bye, got %+v", resp)
	}
}

// route 层 bye 语义：进房后 bye 应作为 {type:"bye"} 广播给对端。
func TestSignalByeRoute(t *testing.T) {
	server := &signalServer{rooms: make(map[string]*signalRoom)}
	srv := httptest.NewServer(newSignalMux(server))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	ctx := context.Background()
	dial := func() *websocket.Conn {
		c, _, err := websocket.Dial(ctx, wsURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	caller := dial()
	defer caller.CloseNow()
	callee := dial()
	defer callee.CloseNow()

	send := func(c *websocket.Conn, r signalRequest) {
		data, _ := json.Marshal(r)
		if err := c.Write(ctx, websocket.MessageText, data); err != nil {
			t.Fatal(err)
		}
	}
	recv := func(c *websocket.Conn) signalResponse {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var resp signalResponse
		if err := json.Unmarshal(data, &resp); err != nil {
			t.Fatal(err)
		}
		return resp
	}

	send(caller, signalRequest{Action: "create"})
	created := recv(caller)
	if created.Type != "created" || created.Room == "" {
		t.Fatalf("expected created, got %+v", created)
	}
	send(callee, signalRequest{Action: "join", Room: created.Room})
	if got := recv(callee); got.Type != "joined" {
		t.Fatalf("expected joined, got %+v", got)
	}
	if got := recv(caller); got.Type != "peer_joined" {
		t.Fatalf("expected peer_joined, got %+v", got)
	}
	send(caller, signalRequest{Action: "bye"})
	if got := recv(callee); got.Type != "bye" {
		t.Fatalf("expected bye forwarded to peer, got %+v", got)
	}
}

