import { describe, expect, it } from 'vitest';

import { isRequestAllowed } from '../src/server/http.js';

/**
 * The local-origin guard.
 *
 * This is the boundary between "a local tool" and "an API every website you
 * visit can drive". A WebSocket is not subject to CORS, and the API accepts a
 * JSON body regardless of content type — so a `text/plain` POST is a CORS
 * simple request with no preflight to fail. Neither is stopped by anything
 * except this check, which is why it is tested rather than assumed.
 *
 * These assume the default loopback bind; the guard stands aside when the user
 * has deliberately bound the engine wider.
 */

const req = (headers: { origin?: string; host?: string }, remoteAddress = '127.0.0.1') => ({
  headers,
  socket: { remoteAddress },
});

describe('local-origin guard', () => {
  it('allows the UI served by the engine itself', () => {
    expect(isRequestAllowed(req({ origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787' }))).toBe(true);
  });

  it('allows the Vite dev server on any loopback port', () => {
    expect(isRequestAllowed(req({ origin: 'http://localhost:5173', host: 'localhost:5173' }))).toBe(true);
    expect(isRequestAllowed(req({ origin: 'http://127.0.0.1:5173', host: '127.0.0.1:8787' }))).toBe(true);
  });

  it('allows a non-browser caller, which sends no Origin', () => {
    expect(isRequestAllowed(req({ host: '127.0.0.1:8787' }))).toBe(true);
    expect(isRequestAllowed(req({}))).toBe(true);
  });

  it('allows IPv6 loopback in both header spellings', () => {
    expect(isRequestAllowed(req({ origin: 'http://[::1]:8787', host: '[::1]:8787' }, '::1'))).toBe(true);
  });

  /* -- the cases this exists for ------------------------------------------- */

  it('refuses a page on the open web reading the event stream', () => {
    // No preflight protects a WebSocket, so this is the whole defence.
    expect(isRequestAllowed(req({ origin: 'https://evil.example', host: '127.0.0.1:8787' }))).toBe(false);
  });

  it('refuses a cross-origin POST that would start a run', () => {
    expect(isRequestAllowed(req({ origin: 'http://attacker.test:8787', host: '127.0.0.1:8787' }))).toBe(false);
  });

  it('refuses an opaque origin from a sandboxed frame or file://', () => {
    expect(isRequestAllowed(req({ origin: 'null', host: '127.0.0.1:8787' }))).toBe(false);
  });

  it('refuses DNS rebinding, where the Host is the attacker domain and no Origin is sent', () => {
    expect(isRequestAllowed(req({ host: 'rebind.evil.example' }))).toBe(false);
  });

  it('refuses a peer that is not on this machine', () => {
    expect(isRequestAllowed(req({ host: '127.0.0.1:8787' }, '192.168.1.50'))).toBe(false);
  });

  it('is not fooled by a hostname that merely starts with a loopback name', () => {
    expect(isRequestAllowed(req({ origin: 'http://localhost.evil.example', host: '127.0.0.1:8787' }))).toBe(false);
    expect(isRequestAllowed(req({ origin: 'http://127.0.0.1.evil.example', host: '127.0.0.1:8787' }))).toBe(false);
  });
});
