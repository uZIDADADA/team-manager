import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { AppConfig } from '../config.js';
import { signJwt } from './jwt.js';
import { verifyPasswordHash } from './password.js';
import { LoginLimiter } from './loginLimiter.js';

const MAX_BODY_BYTES = 4096;
const BODY_TIMEOUT_MS = 5000;
type LoginConfig = Pick<AppConfig, 'adminUsername' | 'adminPasswordHash' | 'jwtIssuer' | 'jwtSecret'>;

export function createLoginRoutes(config: LoginConfig, dependencies: {
  limiter?: LoginLimiter;
  verifyPassword?: typeof verifyPasswordHash;
} = {}) {
  const app = new Hono();
  const limiter = dependencies.limiter ?? new LoginLimiter();
  const verifyPassword = dependencies.verifyPassword ?? verifyPasswordHash;
  app.post('/login', async (c) => {
    c.header('Cache-Control', 'no-store');
    const admission = limiter.acquire(connectionSource(c));
    if ('retryAfter' in admission) {
      c.header('Retry-After', String(admission.retryAfter));
      return c.json({ ok: false, error: `登录尝试过于频繁，请在 ${admission.retryAfter} 秒后重试` }, 429);
    }
    let success = false;
    try {
      const body = await readLoginBody(c.req.raw);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LoginInputError(400, '缺少用户名或密码');
      const { username, password } = body as Record<string, unknown>;
      if (typeof username !== 'string' || !username || username.length > 256 ||
          typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 72 || password.includes('\0')) {
        throw new LoginInputError(400, '用户名或密码格式无效');
      }
      if (username !== config.adminUsername || !config.adminPasswordHash || !(await verifyPassword(password, config.adminPasswordHash))) {
        return c.json({ ok: false, error: '用户名或密码错误' }, 401);
      }
      success = true;
      return c.json({ ok: true, data: { token: signJwt({
        subject: username, issuer: config.jwtIssuer, tokenType: 'access', secret: config.jwtSecret
      }) } });
    } catch (error) {
      if (error instanceof LoginInputError) return c.json({ ok: false, error: error.message }, error.status);
      throw error;
    } finally {
      admission.finish(success);
    }
  });
  return app;
}

function connectionSource(c: Context): string {
  try {
    const address = getConnInfo(c).remote.address;
    // Normalize IPv4-mapped addresses. Unavailable socket metadata shares a bucket.
    return address?.replace(/^::ffff:/i, '').toLowerCase() || 'unknown';
  } catch {
    return 'unknown';
  }
}

class LoginInputError extends Error {
  constructor(readonly status: 400 | 408 | 413, message: string) { super(message); }
}

async function readLoginBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new LoginInputError(413, '登录请求过大');
  const reader = request.body?.getReader();
  if (!reader) throw new LoginInputError(400, '缺少用户名或密码');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LoginInputError(408, '登录请求读取超时')), BODY_TIMEOUT_MS);
  });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new LoginInputError(413, '登录请求过大');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new LoginInputError(400, '登录请求不是有效 JSON'); }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
