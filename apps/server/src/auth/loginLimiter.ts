const WINDOW_MS = 60_000;
const IDLE_MS = 15 * WINDOW_MS;
const MAX_SOURCES = 1024;

interface SourceState {
  windowStart: number;
  attempts: number;
  failures: number;
  blockedUntil: number;
  expiresAt: number;
  active: boolean;
}

type Admission = { retryAfter: number } | { finish(success: boolean): void };

/** Per-process limits; source comes from the socket, never forwarding headers. */
export class LoginLimiter {
  private readonly sources = new Map<string, SourceState>();
  private windowStart = 0;
  private attempts = 0;
  private active = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  acquire(source: string): Admission {
    const now = this.now();
    for (const [key, state] of this.sources) {
      if (!state.active && state.expiresAt <= now) this.sources.delete(key);
    }
    if (now - this.windowStart >= WINDOW_MS) {
      this.windowStart = now;
      this.attempts = 0;
    }
    if (this.active >= 2) return { retryAfter: 1 };
    if (this.attempts >= 60) return retry(this.windowStart + WINDOW_MS - now);
    let state = this.sources.get(source);
    if (!state) {
      // Do not evict active penalties when an attacker rotates source addresses.
      if (this.sources.size >= MAX_SOURCES) return { retryAfter: 60 };
      state = { windowStart: now, attempts: 0, failures: 0, blockedUntil: 0, expiresAt: now + IDLE_MS, active: false };
      this.sources.set(source, state);
    }
    if (state.active) return { retryAfter: 1 };
    if (state.blockedUntil > now) return retry(state.blockedUntil - now);
    if (now - state.windowStart >= WINDOW_MS) {
      state.windowStart = now;
      state.attempts = 0;
    }
    if (state.attempts >= 10) return retry(state.windowStart + WINDOW_MS - now);
    state.attempts++;
    this.attempts++;
    this.active++;
    state.active = true;
    state.expiresAt = now + IDLE_MS;
    let finished = false;
    return { finish: (success) => {
      if (finished) return;
      finished = true;
      this.active--;
      state.active = false;
      state.expiresAt = this.now() + IDLE_MS;
      state.failures = success ? 0 : Math.min(state.failures + 1, 9);
      state.blockedUntil = success || state.failures < 3
        ? 0 : this.now() + Math.min(60, 2 ** (state.failures - 3)) * 1000;
    } };
  }
}

function retry(milliseconds: number): { retryAfter: number } {
  return { retryAfter: Math.max(1, Math.ceil(milliseconds / 1000)) };
}
