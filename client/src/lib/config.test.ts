import { describe, expect, it } from 'vitest';
import { resolveSignalingConfig } from './config';

// Syntax-only fixture. No DNS lookup/connection; not a deployed endpoint.
const validationFixture = 'wss://signal.talkie-validation-fixture.net/rooms';

describe('signaling configuration', () => {
  it.each([undefined, '', '  '])('allows missing development config (%s) only', value => {
    expect(resolveSignalingConfig(value, true)).toEqual({ ok: true, url: 'ws://127.0.0.1:8787' });
    expect(resolveSignalingConfig(value, false)).toMatchObject({ ok: false, error: expect.stringContaining('VITE_SIGNALING_URL is missing') });
  });
  it.each(['ws://127.0.0.1:8787', 'ws://localhost:8787', 'ws://192.168.1.2:8787', validationFixture])('accepts explicit development endpoint %s', url => {
    expect(resolveSignalingConfig(url, true)).toEqual({ ok: true, url });
  });
  it.each([validationFixture, 'wss://8.8.8.8:443/ws', 'wss://[2606:4700:4700::1111]/ws'])('accepts public production syntax %s without claiming deployment', url => {
    expect(resolveSignalingConfig(url, false)).toEqual({ ok: true, url });
  });
  it.each([
    'ws://signal.talkie-validation-fixture.net', 'wss://localhost', 'wss://LOCALHOST.', 'wss://sub.localhost',
    'wss://127.0.0.1', 'wss://127.1', 'wss://2130706433', 'wss://0x7f000001', 'wss://0.0.0.0',
    'wss://10.0.0.1', 'wss://172.16.0.1', 'wss://172.31.255.255', 'wss://192.168.0.1', 'wss://169.254.1.1',
    'wss://100.64.0.1', 'wss://100.127.255.255', 'wss://192.0.2.1', 'wss://198.51.100.1', 'wss://203.0.113.1',
    'wss://198.18.0.1', 'wss://224.0.0.1', 'wss://255.255.255.255',
    'wss://[::]', 'wss://[::1]', 'wss://[fc00::1]', 'wss://[fdff::1]', 'wss://[fe80::1]',
    'wss://[::ffff:127.0.0.1]', 'wss://[::ffff:192.168.1.1]', 'wss://[2001:db8::1]',
    'wss://example.com', 'wss://signal.example.net', 'wss://example.org.', 'wss://signal.example',
    'wss://signal.invalid', 'wss://signal.test', 'wss://your-domain.com', 'wss://placeholder.com',
    'wss://signal.local', 'wss://signal.internal', 'wss://signal.home', 'wss://signal.lan', 'wss://signal',
    'wss://bad_host.net',
  ])('rejects non-public or placeholder production endpoint %s', url => {
    expect(resolveSignalingConfig(url, false)).toMatchObject({ ok: false, error: expect.stringContaining('real public wss://') });
  });
  it.each([true, false])('rejects malformed/unsafe explicit config (development=%s)', development => {
    for (const url of ['not a URL', 'https://signal.talkie-validation-fixture.net', 'wss:signal.talkie-validation-fixture.net',
      'wss://user:secret@signal.talkie-validation-fixture.net', 'wss://@signal.talkie-validation-fixture.net',
      `${validationFixture}#token`, `${validationFixture}#`, 'wss://bad host.net',
      'wss://signal.talkie-validation-fixture.net\\path', 'wss://signal.talkie-validation-fixture.net:99999']) {
      const result = resolveSignalingConfig(url, development);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.error).not.toContain('secret');
    }
  });

  it('prefers the runtime localStorage override over the build environment', () => {
    const storage = new Map<string, string>([['talkie.signalingUrl', validationFixture]]);
    const runtime = { getItem: (key: string) => storage.get(key) ?? null };
    expect(resolveSignalingConfig('wss://build.example.net/ws', false, runtime)).toEqual({ ok: true, url: validationFixture });
  });

  it('validates a runtime production override as a public wss endpoint', () => {
    const storage = { getItem: () => 'ws://127.0.0.1:8787' };
    expect(resolveSignalingConfig(validationFixture, false, storage)).toMatchObject({ ok: false, error: expect.stringContaining('real public wss://') });
  });

  it('falls back to the development loopback when no runtime or build URL exists', () => {
    expect(resolveSignalingConfig(undefined, true, { getItem: () => null })).toEqual({ ok: true, url: 'ws://127.0.0.1:8787' });
  });
});
