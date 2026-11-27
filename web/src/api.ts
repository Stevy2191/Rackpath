// The one way the app talks to the server: same-origin fetch with the
// session cookie, JSON in and out, and errors carrying the server's message
// and machine-readable code (e.g. "password_change_required").

export class ApiError extends Error {
  status: number;
  code?: string;
  body: unknown;
  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

type Listener = (e: ApiError) => void;
const gateListeners = new Set<Listener>();

/** Notified when a request fails because the session needs something
 * (sign-in, a second factor, a password change, 2FA set-up). */
export function onGate(fn: Listener): () => void {
  gateListeners.add(fn);
  return () => gateListeners.delete(fn);
}

const GATES = new Set(['mfa_required', 'password_change_required', 'two_factor_setup_required']);

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body instanceof Blob || body instanceof ArrayBuffer || typeof body === 'string') {
    payload = body as BodyInit;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', ...init });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const obj = (data && typeof data === 'object' ? data : {}) as { error?: string; code?: string };
    const err = new ApiError(res.status, obj.error || res.statusText || 'Request failed', obj.code, data);
    if (res.status === 401 || (res.status === 403 && obj.code && GATES.has(obj.code))) {
      gateListeners.forEach((l) => l(err));
    }
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T,>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T,>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T = void,>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  /** Raw upload (images, XML, CSV). */
  upload: <T,>(method: 'POST' | 'PUT', path: string, data: Blob | string, type: string) =>
    request<T>(method, path, data, { headers: { 'Content-Type': type, Accept: 'application/json' } }),
};

/** Builds a query string from defined values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
