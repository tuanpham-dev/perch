import { test } from 'node:test';
import assert from 'node:assert/strict';

// The tunnel CLI starts itself on import unless told not to.
process.env.PERCH_TUNNEL_NO_MAIN = '1';
const { openerFor, openUrlFrame, rewriteForBrowser } = await import('./tunnel.mjs');

const base = 'https://perch.example.com';
const localFor = new Map([[5173, 5173], [8080, 18080]]);

test('the opener for each platform', () => {
  assert.deepEqual(openerFor('darwin', 'http://x/?a=1&b=2'), { cmd: 'open', args: ['http://x/?a=1&b=2'] });
  assert.deepEqual(openerFor('win32', 'http://x/'), { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', 'http://x/'] });
  assert.deepEqual(openerFor('linux', 'http://x/'), { cmd: 'xdg-open', args: ['http://x/'] });
});

test('server-side localhost URLs become what works here', () => {
  const opts = { base, serverPort: 3001, proxyDomain: null, localFor };
  // Forwarded by this tunnel: localhost here, at its local port.
  assert.equal(rewriteForBrowser('http://localhost:5173/a?b=1#c', opts), 'http://localhost:5173/a?b=1#c');
  assert.equal(rewriteForBrowser('http://127.0.0.1:8080/', opts), 'http://localhost:18080/');
  // The app's own port: the app at the address the tunnel reaches it by.
  assert.equal(rewriteForBrowser('http://localhost:3001/settings', opts), 'https://perch.example.com/settings');
  // Anything else: the port proxy, path form or subdomain form.
  assert.equal(rewriteForBrowser('http://[::1]:9000/x', opts), 'https://perch.example.com/proxy/9000/x');
  assert.equal(rewriteForBrowser('http://0.0.0.0:9000/', { ...opts, proxyDomain: 'example.com' }), 'https://9000.example.com/');
  // Not loopback: unchanged.
  assert.equal(rewriteForBrowser('https://github.com/login/device', opts), 'https://github.com/login/device');
});

test('open requests: only http(s), rewritten unless direct', () => {
  const ctx = { base, localFor };
  assert.deepEqual(openUrlFrame({ url: 'http://localhost:9000/', serverPort: 3001 }, ctx), { ok: true, url: 'https://perch.example.com/proxy/9000/' });
  assert.deepEqual(openUrlFrame({ url: 'http://localhost:9000/', direct: true }, ctx), { ok: true, url: 'http://localhost:9000/' });
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', '', `http://x/${'a'.repeat(2100)}`]) {
    assert.equal(openUrlFrame({ url }, ctx).ok, false, url.slice(0, 30));
  }
  assert.equal(openUrlFrame(null, ctx).ok, false);
});
