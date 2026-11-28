export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type RequestOptions = RequestInit & { timeoutMs?: number };

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (import.meta.env.MODE === 'demo') {
    const { demoApi } = await import('./demo/api');
    options.signal?.throwIfAborted();
    return demoApi(path, options) as Promise<T>;
  }
  const { timeoutMs = 15000, signal, ...init } = options;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const headers = new Headers(init.headers);
  if (init.method && !['GET', 'HEAD'].includes(init.method.toUpperCase())) {
    headers.set('X-Tattoo-Request', '1');
  }
  try {
    const response = await fetch(`/api/v1${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (
        response.status === 401 &&
        !['/auth/login', '/auth/login/verify', '/auth/login/cancel', '/auth/me'].includes(path)
      ) {
        window.dispatchEvent(new Event('tattoo:unauthorized'));
      }
      throw new ApiError(
        typeof payload?.error?.message === 'string'
          ? payload.error.message
          : '请求未完成，请稍后重试',
        response.status,
        typeof payload?.error?.code === 'string' ? payload.error.code : `HTTP_${response.status}`,
        payload?.error?.details,
      );
    }
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data')) {
      throw new ApiError('服务返回了无法识别的结果，请稍后重试', 502, 'INVALID_RESPONSE');
    }
    return payload.data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw error;
    throw new ApiError('连接中断或请求超时，请检查网络后重试', 0, 'NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export function jsonRequest(value: unknown): Pick<RequestInit, 'body' | 'headers'> {
  return { body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试';
}

// randomUUID is restricted to secure contexts; getRandomValues also works on a NAS's LAN HTTP URL.
export function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
