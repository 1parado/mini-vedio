package main

import "testing"

func TestTruncateDiagnosticPreservesUTF8(t *testing.T) {
	got := truncateDiagnostic("你好世界", 3)
	if got != "你好世" {
		t.Fatalf("truncateDiagnostic() = %q, want %q", got, "你好世")
	}
}

func TestLanServicePeersBeforeStartup(t *testing.T) {
	s := NewLanService(&Device{ID: "test-device", Name: "测试"})
	if peers := s.Peers(); peers == nil {
		t.Fatal("Peers() returned nil before ServiceStartup")
	}
	s.emitPeers()
}
