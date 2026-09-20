import { describe, expect, it } from 'vitest';
import { getSafeHeader, setSafeHeaders, toUrlString } from '../../src/plugin/headers';

describe('plugin/headers', () => {
  describe('getSafeHeader', () => {
    it('returns undefined for empty/null headers', () => {
      expect(getSafeHeader(null, 'Content-Type')).toBeUndefined();
      expect(getSafeHeader(undefined, 'Content-Type')).toBeUndefined();
    });

    it('retrieves header from Headers object case-insensitively', () => {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      expect(getSafeHeader(headers, 'content-type')).toBe('application/json');
      expect(getSafeHeader(headers, 'CONTENT-TYPE')).toBe('application/json');
    });

    it('retrieves header from array of tuples case-insensitively', () => {
      const headers: [string, string][] = [
        ['Content-Type', 'text/plain'],
        ['X-Custom', 'value'],
      ];
      expect(getSafeHeader(headers, 'x-custom')).toBe('value');
      expect(getSafeHeader(headers, 'X-CUSTOM')).toBe('value');
      expect(getSafeHeader(headers, 'non-existent')).toBeUndefined();
    });

    it('retrieves header from plain object case-insensitively', () => {
      const headers = { 'X-Api-Key': 'secret123' };
      expect(getSafeHeader(headers, 'x-api-key')).toBe('secret123');
      expect(getSafeHeader(headers, 'missing')).toBeUndefined();
    });

    it('handles object with undefined property', () => {
      const headers = { 'x-foo': undefined };
      expect(getSafeHeader(headers, 'x-foo')).toBeUndefined();
    });

    it('handles non-object primitive input', () => {
      expect(getSafeHeader(123 as any, 'x-foo')).toBeUndefined();
    });
  });

  describe('setSafeHeaders', () => {
    it('updates Headers instance', () => {
      const headers = new Headers({ 'Content-Type': 'text/plain' });
      const updated = setSafeHeaders(headers, { 'Content-Type': 'application/json', 'X-New': '1' });
      expect(updated).toBeInstanceOf(Headers);
      expect((updated as Headers).get('Content-Type')).toBe('application/json');
      expect((updated as Headers).get('X-New')).toBe('1');
    });

    it('updates array of tuples', () => {
      const originalHeaders = globalThis.Headers;
      try {
        // Temporarily unset globalThis.Headers to test array/object fallback branches
        (globalThis as any).Headers = undefined;

        const headers: [string, string][] = [['Content-Type', 'text/plain']];
        const updated = setSafeHeaders(headers, { 'Content-Type': 'application/json', 'X-New': '2' }) as [string, string][];
        expect(Array.isArray(updated)).toBe(true);
        expect(updated.find(h => h[0].toLowerCase() === 'content-type')?.[1]).toBe('application/json');
        expect(updated.find(h => h[0].toLowerCase() === 'x-new')?.[1]).toBe('2');
      } finally {
        (globalThis as any).Headers = originalHeaders;
      }
    });

    it('updates plain record object', () => {
      const originalHeaders = globalThis.Headers;
      try {
        (globalThis as any).Headers = undefined;

        const headers = { 'Content-Type': 'text/plain' };
        const updated = setSafeHeaders(headers, { 'content-type': 'application/json', 'x-extra': 'val' }) as Record<string, string>;
        expect(updated['Content-Type']).toBe('application/json');
        expect(updated['x-extra']).toBe('val');
      } finally {
        (globalThis as any).Headers = originalHeaders;
      }
    });
  });

  describe('toUrlString', () => {
    it('returns string unchanged', () => {
      expect(toUrlString('https://example.com/api')).toBe('https://example.com/api');
    });

    it('extracts url from Request object', () => {
      const req = new Request('https://example.com/from-request');
      expect(toUrlString(req)).toBe('https://example.com/from-request');
    });

    it('falls back to toString() if url is empty', () => {
      const obj = {
        toString: () => 'https://example.com/custom-object',
      };
      expect(toUrlString(obj as any)).toBe('https://example.com/custom-object');
    });
  });
});
