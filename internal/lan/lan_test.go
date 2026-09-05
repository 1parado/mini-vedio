package lan

import (
	"testing"
	"time"
)

// 验证两个 Hub 能通过广播互相发现，并完成 offer/answer/decline 的信令交换。
func TestTwoHubsDiscoverAndSignal(t *testing.T) {
	const testPort = DefaultPort // 复用真实端口，同时验证多实例绑定（SO_REUSEADDR）

	events := func(done chan<- Event) func(Event) {
		return func(ev Event) {
			select {
			case done <- ev:
			default:
			}
		}
	}

	// 事件通道容量放大，避免丢弃 peers 事件
	chA := make(chan Event, 64)
	chB := make(chan Event, 64)

	hubA, err := New(testPort, "dev-a", func() string { return "甲" }, func() string { return "idle" }, events(chA))
	if err != nil {
		t.Fatalf("创建 Hub A 失败: %v", err)
	}
	defer hubA.Close()
	hubB, err := New(testPort, "dev-b", func() string { return "乙" }, func() string { return "idle" }, events(chB))
	if err != nil {
		t.Fatalf("创建 Hub B 失败: %v", err)
	}
	defer hubB.Close()
	hubA.Start()
	hubB.Start()

	// 1) 双向发现
	waitPeer(t, hubA, "dev-b", 10*time.Second)
	waitPeer(t, hubB, "dev-a", 10*time.Second)

	// 2) A 呼叫 B：offer → incoming → answer
	if err := hubA.SendOffer("dev-b", "call-1", "offer-sdp"); err != nil {
		t.Fatalf("SendOffer 失败: %v", err)
	}
	incoming := waitEvent(t, chB, EventIncoming, 10*time.Second)
	if incoming.FromID != "dev-a" || incoming.CallID != "call-1" || incoming.SDP != "offer-sdp" {
		t.Fatalf("来电事件不符合预期: %+v", incoming)
	}
	if err := hubB.AcceptCall("dev-a", "call-1", "answer-sdp"); err != nil {
		t.Fatalf("AcceptCall 失败: %v", err)
	}
	answer := waitEvent(t, chA, EventAnswer, 10*time.Second)
	if answer.CallID != "call-1" || answer.SDP != "answer-sdp" {
		t.Fatalf("应答事件不符合预期: %+v", answer)
	}

	// 3) 二次呼叫被拒绝
	if err := hubA.SendOffer("dev-b", "call-2", "offer-2"); err != nil {
		t.Fatalf("SendOffer 失败: %v", err)
	}
	waitEvent(t, chB, EventIncoming, 10*time.Second)
	if err := hubB.DeclineCall("dev-a", "call-2"); err != nil {
		t.Fatalf("DeclineCall 失败: %v", err)
	}
	declined := waitEvent(t, chA, EventDecline, 10*time.Second)
	if declined.CallID != "call-2" {
		t.Fatalf("拒绝事件不符合预期: %+v", declined)
	}

	// 4) bye 挂断事件
	if err := hubA.SendBye("dev-b", "call-1"); err != nil {
		t.Fatalf("SendBye 失败: %v", err)
	}
	bye := waitEvent(t, chB, EventBye, 10*time.Second)
	if bye.CallID != "call-1" {
		t.Fatalf("挂断事件不符合预期: %+v", bye)
	}
}

func TestSignalValidation(t *testing.T) {
	if validCall("") || validCall(string(make([]byte, maxCallIDBytes+1))) {
		t.Fatal("callId 校验未拒绝空值或超长值")
	}
	if validSDP("") || validSDP(string(make([]byte, maxSDPBytes+1))) {
		t.Fatal("SDP 校验未拒绝空值或超长值")
	}
}

func waitPeer(t *testing.T, h *Hub, id string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, p := range h.Peers() {
			if p.ID == id {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("等待发现设备 %s 超时（当前: %+v）", id, h.Peers())
}

func waitEvent(t *testing.T, ch <-chan Event, kind string, timeout time.Duration) Event {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case ev := <-ch:
			if ev.Kind == kind {
				return ev
			}
		case <-deadline:
			t.Fatalf("等待事件 %s 超时", kind)
		}
	}
}
