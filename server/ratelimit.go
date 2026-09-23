package server

import (
	"fmt"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// PasswordLimiter throttles requests that carry a track password, per client.
//
// Checking a password is deliberately expensive, and nothing else stops a
// client from guessing as fast as it can send requests — at the admin
// password, or at every private track at once via the list endpoint. Requests
// without a password never check one, so they are never throttled.
//
// It is a token bucket: each client may make `burst` password requests at
// once, refilled at `rate` per second.
type PasswordLimiter struct {
	rate       float64
	burst      float64
	trustProxy bool
	now        func() time.Time // replaceable in tests

	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

// maxBuckets bounds memory: past this many clients, idle ones are dropped.
const maxBuckets = 4096

// NewPasswordLimiter allows `burst` password requests per client, refilling at
// one every `every`. With trustProxy set, the client is taken from the
// X-Forwarded-For / X-Real-IP headers a reverse proxy adds — only enable that
// behind a proxy you control, since clients can otherwise forge them.
func NewPasswordLimiter(burst int, every time.Duration, trustProxy bool) *PasswordLimiter {
	return &PasswordLimiter{
		rate:       1 / every.Seconds(),
		burst:      float64(burst),
		trustProxy: trustProxy,
		now:        time.Now,
		buckets:    map[string]*bucket{},
	}
}

// Wrap applies the limit to a handler.
func (l *PasswordLimiter) Wrap(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Track-Password") == "" {
			h(w, r)
			return
		}
		ok, wait := l.allow(l.clientKey(r))
		if !ok {
			w.Header().Set("Retry-After", fmt.Sprint(int(math.Ceil(wait.Seconds()))))
			writeError(w, http.StatusTooManyRequests,
				"too many password attempts — wait a moment and try again")
			return
		}
		h(w, r)
	}
}

// allow takes a token for key, reporting how long to wait if none is left.
func (l *PasswordLimiter) allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()

	if len(l.buckets) >= maxBuckets {
		l.dropIdle(now)
	}
	b, found := l.buckets[key]
	if !found {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens = math.Min(l.burst, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	return false, time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
}

// dropIdle forgets clients whose bucket has refilled: they are
// indistinguishable from a client never seen before. Caller holds l.mu.
func (l *PasswordLimiter) dropIdle(now time.Time) {
	for k, b := range l.buckets {
		if b.tokens+now.Sub(b.last).Seconds()*l.rate >= l.burst {
			delete(l.buckets, k)
		}
	}
}

func (l *PasswordLimiter) clientKey(r *http.Request) string {
	if l.trustProxy {
		// The left-most X-Forwarded-For entry is the original client.
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			first, _, _ := strings.Cut(xff, ",")
			if ip := strings.TrimSpace(first); ip != "" {
				return ip
			}
		}
		if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
