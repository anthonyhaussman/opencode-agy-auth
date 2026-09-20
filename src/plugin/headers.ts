/**
 * HTTP header and URL manipulation utilities.
 * Shared between OpenCode v1 and v2 runtimes.
 */

export function getSafeHeader(headers: unknown, key: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const targetKey = key.toLowerCase();

  if (typeof (headers as any).get === 'function') {
    try {
      return (headers as any).get(targetKey) || undefined;
    } catch {
      // Fallback
    }
  }

  if (Array.isArray(headers)) {
    const found = headers.find((item) => {
      if (Array.isArray(item) && typeof item[0] === 'string') {
        return item[0].toLowerCase() === targetKey;
      }
      return false;
    });
    return found ? String(found[1]) : undefined;
  }

  if (typeof headers === 'object') {
    const foundKey = Object.keys(headers).find(k => k.toLowerCase() === targetKey);
    return foundKey ? ((headers as Record<string, unknown>)[foundKey] !== undefined ? String((headers as Record<string, unknown>)[foundKey]) : undefined) : undefined;
  }

  return undefined;
}

export function setSafeHeaders(initHeaders: unknown, newHeaders: Record<string, string>): unknown {
  if (typeof globalThis.Headers !== 'undefined') {
    const headers = new globalThis.Headers((initHeaders as any) ?? {});
    for (const [k, v] of Object.entries(newHeaders)) {
      headers.set(k, v);
    }
    return headers;
  }

  if (Array.isArray(initHeaders)) {
    const nextHeaders = [...initHeaders];
    for (const [k, v] of Object.entries(newHeaders)) {
      const idx = nextHeaders.findIndex(item => Array.isArray(item) && typeof item[0] === 'string' && item[0].toLowerCase() === k.toLowerCase());
      if (idx !== -1) {
        nextHeaders[idx] = [k, v];
      } else {
        nextHeaders.push([k, v]);
      }
    }
    return nextHeaders;
  }

  const nextHeaders: Record<string, string> = {};
  if (initHeaders && typeof initHeaders === 'object') {
    for (const [k, v] of Object.entries(initHeaders)) {
      nextHeaders[k] = String(v);
    }
  }
  for (const [k, v] of Object.entries(newHeaders)) {
    const existingKey = Object.keys(nextHeaders).find(key => key.toLowerCase() === k.toLowerCase());
    if (existingKey) {
      nextHeaders[existingKey] = v;
    } else {
      nextHeaders[k] = v;
    }
  }
  return nextHeaders;
}

export function toUrlString(value: RequestInfo): string {
  if (typeof value === 'string') {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}
