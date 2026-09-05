package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	maxDiagnosticFileBytes       = 2 * 1024 * 1024
	maxDiagnosticExportBytes     = 4 * 1024 * 1024
	maxDiagnosticWritesPerMinute = 600
)

type diagnosticEntry struct {
	Timestamp string `json:"ts"`
	Level     string `json:"level"`
	Event     string `json:"event"`
	Detail    string `json:"detail,omitempty"`
}

var diagnosticsMu sync.Mutex
var diagnosticWindow struct {
	start  time.Time
	writes int
}

func diagnosticsPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "diagnostics.jsonl"), nil
}

func appendDiagnostic(level, event, detail string) error {
	level = strings.TrimSpace(level)
	if level != "info" && level != "warn" && level != "error" {
		level = "info"
	}
	entry := diagnosticEntry{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Level:     level,
		Event:     truncateDiagnostic(event, 80),
		Detail:    truncateDiagnostic(detail, 500),
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	path, err := diagnosticsPath()
	if err != nil {
		return err
	}
	diagnosticsMu.Lock()
	defer diagnosticsMu.Unlock()
	now := time.Now()
	if diagnosticWindow.start.IsZero() || now.Sub(diagnosticWindow.start) >= time.Minute {
		diagnosticWindow.start = now
		diagnosticWindow.writes = 0
	}
	if diagnosticWindow.writes >= maxDiagnosticWritesPerMinute {
		return nil
	}
	if err := rotateDiagnosticsLocked(path); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(data, '\n'))
	if err == nil {
		diagnosticWindow.writes++
	}
	return err
}

func rotateDiagnosticsLocked(path string) error {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Size() < maxDiagnosticFileBytes {
		return nil
	}
	backup := path + ".1"
	_ = os.Remove(backup)
	return os.Rename(path, backup)
}

func readDiagnostics() (string, error) {
	path, err := diagnosticsPath()
	if err != nil {
		return "", err
	}
	diagnosticsMu.Lock()
	defer diagnosticsMu.Unlock()
	var b strings.Builder
	for _, candidate := range []string{path + ".1", path} {
		file, openErr := os.Open(candidate)
		if errors.Is(openErr, os.ErrNotExist) {
			continue
		}
		if openErr != nil {
			return "", openErr
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 64*1024), 512*1024)
		for scanner.Scan() {
			b.WriteString(scanner.Text())
			b.WriteByte('\n')
			if b.Len() >= maxDiagnosticExportBytes {
				break
			}
		}
		closeErr := file.Close()
		if err := scanner.Err(); err != nil {
			return "", err
		}
		if closeErr != nil {
			return "", closeErr
		}
		if b.Len() >= maxDiagnosticExportBytes {
			break
		}
	}
	return b.String(), nil
}

func clearDiagnostics() error {
	path, err := diagnosticsPath()
	if err != nil {
		return err
	}
	diagnosticsMu.Lock()
	defer diagnosticsMu.Unlock()
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Remove(path + ".1"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func truncateDiagnostic(value string, max int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}
