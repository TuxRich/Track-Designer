package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// limiterWithClock returns a limiter whose time is controlled by the test.
func limiterWithClock(burst int, every time.Duration, trustProxy bool) (*PasswordLimiter, *time.Time) {
	l := NewPasswordLimiter(burst, every, trustProxy)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return now }
	return l, &now
}

func hit(h http.Handler, remoteAddr, password string, headers map[string]string) int {
	req := httptest.NewRequest("GET", "/api/tracks", nil)
	req.RemoteAddr = remoteAddr
	if password != "" {
		req.Header.Set("X-Track-Password", password)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

var okHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
})

func TestLimiterAllowsBurstThenThrottlesThenRefills(t *testing.T) {
	l, now := limiterWithClock(3, time.Second, false)
	h := l.Wrap(okHandler)

	for i := 0; i < 3; i++ {
		if code := hit(h, "1.2.3.4:5", "guess", nil); code != http.StatusOK {
			t.Fatalf("request %d within burst: got %d", i, code)
		}
	}
	if code := hit(h, "1.2.3.4:5", "guess", nil); code != http.StatusTooManyRequests {
		t.Fatalf("request past burst: got %d, want 429", code)
	}
	*now = now.Add(time.Second) // one token back
	if code := hit(h, "1.2.3.4:5", "guess", nil); code != http.StatusOK {
		t.Fatalf("after refill: got %d", code)
	}
	if code := hit(h, "1.2.3.4:5", "guess", nil); code != http.StatusTooManyRequests {
		t.Fatalf("refill should be one token, not a full burst: got %d", code)
	}
}

func TestLimiterIgnoresRequestsWithoutPassword(t *testing.T) {
	l, _ := limiterWithClock(1, time.Hour, false)
	h := l.Wrap(okHandler)
	for i := 0; i < 50; i++ {
		if code := hit(h, "1.2.3.4:5", "", nil); code != http.StatusOK {
			t.Fatalf("ordinary browsing must never be throttled: request %d got %d", i, code)
		}
	}
}

func TestLimiterIsPerClient(t *testing.T) {
	l, _ := limiterWithClock(1, time.Hour, false)
	h := l.Wrap(okHandler)
	hit(h, "1.1.1.1:1", "x", nil)
	if code := hit(h, "1.1.1.1:2", "x", nil); code != http.StatusTooManyRequests {
		t.Fatalf("same client, other port: got %d, want 429", code)
	}
	if code := hit(h, "2.2.2.2:1", "x", nil); code != http.StatusOK {
		t.Fatalf("a different client must have its own allowance: got %d", code)
	}
}

func TestLimiterProxyHeadersOnlyWhenTrusted(t *testing.T) {
	spoof := map[string]string{"X-Forwarded-For": "9.9.9.9"}

	// Untrusted: a client can't escape its limit by inventing a header.
	l, _ := limiterWithClock(1, time.Hour, false)
	h := l.Wrap(okHandler)
	hit(h, "1.1.1.1:1", "x", spoof)
	if code := hit(h, "1.1.1.1:1", "x", map[string]string{"X-Forwarded-For": "8.8.8.8"}); code != http.StatusTooManyRequests {
		t.Fatalf("forged X-Forwarded-For bypassed the limit: got %d", code)
	}

	// Trusted: behind one proxy, every client shares its address, so the
	// forwarded header is what tells them apart.
	l, _ = limiterWithClock(1, time.Hour, true)
	h = l.Wrap(okHandler)
	hit(h, "10.0.0.1:1", "x", map[string]string{"X-Forwarded-For": "5.5.5.5, 10.0.0.1"})
	if code := hit(h, "10.0.0.1:1", "x", map[string]string{"X-Forwarded-For": "6.6.6.6"}); code != http.StatusOK {
		t.Fatalf("different clients behind the proxy were lumped together: got %d", code)
	}
	if code := hit(h, "10.0.0.1:1", "x", map[string]string{"X-Forwarded-For": "5.5.5.5"}); code != http.StatusTooManyRequests {
		t.Fatalf("same client behind the proxy wasn't limited: got %d", code)
	}
}

func TestLimiterForgetsIdleClients(t *testing.T) {
	l, now := limiterWithClock(1, time.Second, false)
	for i := 0; i < maxBuckets; i++ {
		l.allow(string(rune(i)))
	}
	*now = now.Add(time.Minute) // every bucket has refilled
	l.allow("newcomer")
	if len(l.buckets) > 2 {
		t.Fatalf("idle clients should be dropped, %d buckets remain", len(l.buckets))
	}
}
