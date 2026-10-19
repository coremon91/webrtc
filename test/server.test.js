const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server');

function event(socket, name, predicate = () => true, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error(`Timeout: ${name}`)); }, ms);
    function handler(data) { if (predicate(data)) { clearTimeout(timer); socket.off(name, handler); resolve(data); } }
    socket.on(name, handler);
  });
}
async function fixture(t, env = {}) {
  const server = createServer(env);
  await new Promise(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.httpServer.address().port}`;
  const clients = [];
  t.after(async () => {
    clients.forEach(s => s.disconnect());
    await new Promise(resolve => server.io.close(resolve));
  });
  async function client(key) {
    const socket = connect(url, { autoConnect: false, reconnection: false, forceNew: true,
      transports: ['websocket'], auth: { accessKey: key } });
    clients.push(socket);
    const ready = event(socket, 'connect'); socket.connect(); await ready; return socket;
  }
  async function join(socket, role, room = 'studio', name = role) {
    const ready = event(socket, 'room:joined'); socket.emit('room:join', { room, role, name }); return ready;
  }
  return { ...server, url, client, join, clients };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('health, static UI and TURN REST credentials match coturn', async t => {
  const f = await fixture(t, { TURN_HOST: 'turn.example.org', TURN_SECRET: 'test-only-secret', TURN_TTL_SECONDS: '120', TURN_TLS_PORT: '5349' });
  assert.equal((await fetch(`${f.url}/api/health`).then(r => r.json())).ok, true);
  assert.match(await fetch(f.url).then(r => r.text()), /mainVideo/);
  const response = await fetch(`${f.url}/api/turn-credentials`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.turnConfigured, true);
  assert(Math.abs(data.expireAt - Math.floor(Date.now() / 1000) - 120) <= 2);
  const entries = data.servers.filter(s => s.urls.some(url => /^turns?:/.test(url)));
  assert(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.username, String(data.expireAt));
    assert.equal(entry.credential, crypto.createHmac('sha1', 'test-only-secret').update(entry.username).digest('base64'));
    assert(entry.urls.every(url => !url.includes('://')));
  }
  assert(data.servers.some(s => s.urls.includes('turn:turn.example.org:3478?transport=udp')));
  assert(data.servers.some(s => s.urls.includes('turns:turn.example.org:5349?transport=tcp')));
});

test('access key protects HTTP and sockets including wrong-length credentials', async t => {
  const f = await fixture(t, { ACCESS_KEY: 'test-key' });
  assert.equal((await fetch(`${f.url}/api/turn-credentials`)).status, 401);
  assert.equal((await fetch(`${f.url}/api/turn-credentials`, { headers: { Authorization: 'Bearer test-key' } })).status, 200);
  const bad = connect(f.url, { autoConnect: false, reconnection: false, auth: { accessKey: 'x' } });
  f.clients.push(bad); const rejected = event(bad, 'connect_error'); bad.connect();
  assert.match((await rejected).message, /key|auth|접속/i);
  const good = await f.client('test-key'); assert(good.connected);
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
});

test('single sender, viewer capacity and idempotent rejoin', async t => {
  const f = await fixture(t, { MAX_VIEWERS: '1' });
  const sender = await f.client(), other = await f.client(), viewer = await f.client();
  await f.join(sender, 'sender');
  let rejected = event(other, 'room:rejected'); other.emit('room:join', { room: 'studio', role: 'sender' });
  assert.equal((await rejected).code, 'sender-exists');
  const state = await f.join(viewer, 'viewer'); assert.equal(state.viewerCount, 1); assert.equal(state.senderId, sender.id);
  assert.equal((await f.join(viewer, 'viewer')).viewerCount, 1);
  rejected = event(other, 'room:rejected'); other.emit('room:join', { room: 'studio', role: 'viewer' });
  assert.equal((await rejected).code, 'room-full');
});

test('malformed joins and signals never throw or kill the server', async t => {
  const f = await fixture(t); const s = await f.client();
  for (const packet of [null, [], 42, { role: 'alien' }, { role: 'sender', name: {} }, { role: 'viewer', room: {} }]) {
    const rejected = event(s, 'room:rejected'); s.emit('room:join', packet); assert.equal((await rejected).code, 'invalid-request');
  }
  for (const packet of [null, [], 42, { payload: null }, { to: 'x', payload: { kind: 'candidate' } }]) s.emit('room:message', packet);
  assert.equal((await f.join(s, 'sender')).members.length, 1);
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
});

test('only valid opposite-role signals relay and trusted envelope cannot be spoofed', async t => {
  const f = await fixture(t); const s = await f.client(), v = await f.client(), v2 = await f.client(), outsider = await f.client();
  await f.join(s, 'sender'); await f.join(v, 'viewer'); await f.join(v2, 'viewer'); await f.join(outsider, 'viewer', 'other');
  const offer = { kind: 'offer', sdp: { type: 'offer', sdp: 'example-sdp' }, sessionId: 'session1', from: 'spoof', name: 'spoof' };
  let received = event(v, 'room:signal'); s.emit('room:message', { to: v.id, payload: offer });
  const signal = await received; assert.equal(signal.from, s.id); assert.equal(signal.name, 'sender'); assert.equal(signal.payload.kind, 'offer');
  assert.equal(signal.payload.from, undefined); assert.equal(signal.payload.name, undefined);
  received = event(s, 'room:signal'); v.emit('room:message', { to: s.id, payload: { kind: 'answer', sdp: { type: 'answer', sdp: 'answer-sdp' }, sessionId: 'session1' } });
  assert.equal((await received).payload.kind, 'answer');
  received = event(v, 'room:signal'); s.emit('room:message', { to: v.id, payload: { kind: 'candidate', data: { candidate: 'candidate:1 1 UDP 1 127.0.0.1 1234 typ host', sdpMid: '0', sdpMLineIndex: 0 }, sessionId: 'session1' } });
  assert.equal((await received).payload.data.sdpMLineIndex, 0);
  received = event(s, 'room:signal'); v.emit('room:message', { to: s.id, payload: { kind: 'retry' } });
  assert.deepEqual((await received).payload, { kind: 'retry' });
  const unexpected = []; const collect = p => unexpected.push(p); s.on('room:signal', collect); v.on('room:signal', collect); v2.on('room:signal', collect); outsider.on('room:signal', collect);
  v.emit('room:message', { to: v2.id, payload: offer });
  outsider.emit('room:message', { to: s.id, payload: { kind: 'retry' } });
  s.emit('room:message', { to: v.id, payload: { kind: 'answer', sdp: { type: 'answer', sdp: 'x' }, sessionId: 'session1' } });
  s.emit('room:message', { to: v.id, payload: { kind: 'offer', sdp: { type: 'answer', sdp: 'x' }, sessionId: 'session1' } });
  s.emit('room:message', { to: v.id, payload: { kind: 'invalid', sessionId: 'session1' } });
  s.emit('room:message', { to: v.id, payload: { kind: 'offer', sdp: { type: 'offer', sdp: 'x' } } });
  await pause(80); assert.deepEqual(unexpected, []);
});

test('leave and room switch clear subscriptions, sender ownership and old membership', async t => {
  const f = await fixture(t); const s = await f.client(), v = await f.client();
  await f.join(s, 'sender'); await f.join(v, 'viewer');
  const left = event(v, 'room:state'); s.emit('room:leave');
  assert.equal((await left).senderId, null);
  assert.equal(f.io.sockets.sockets.get(s.id).data.room, undefined);
  assert(!f.io.sockets.sockets.get(s.id).rooms.has('broadcast:studio'));
  await f.join(s, 'sender');
  const switched = event(v, 'room:state', packet => packet.senderId === null); await f.join(s, 'sender', 'second'); assert.equal((await switched).senderId, null);
  assert(!f.io.sockets.sockets.get(s.id).rooms.has('broadcast:studio'));
  const replacement = await f.client(); assert.equal((await f.join(replacement, 'sender')).senderId, replacement.id);
});

test('viewer waits before sender, survives sender departure and sees new sender', async t => {
  const f = await fixture(t); const v = await f.client(), s = await f.client();
  assert.equal((await f.join(v, 'viewer')).senderId, null);
  let update = event(v, 'room:state'); await f.join(s, 'sender'); assert.equal((await update).senderId, s.id);
  update = event(v, 'room:state'); s.disconnect(); assert.equal((await update).senderId, null);
  const fresh = await f.client(); update = event(v, 'room:state'); await f.join(fresh, 'sender'); assert.equal((await update).senderId, fresh.id);
});

test('failed room switch retains previous membership', async t => {
  const f = await fixture(t); const a = await f.client(), b = await f.client();
  await f.join(a, 'sender', 'one'); await f.join(b, 'sender', 'two');
  const rejected = event(a, 'room:rejected'); a.emit('room:join', { role: 'sender', room: 'two' });
  assert.equal((await rejected).code, 'sender-exists'); assert.equal(f.io.sockets.sockets.get(a.id).data.room, 'one');
});

test('same-room role change with a single member keeps registry intact', async t => {
  const f = await fixture(t); const a = await f.client(), b = await f.client();
  await f.join(a, 'viewer');
  assert.equal((await f.join(a, 'sender')).senderId, a.id);
  const state = await f.join(b, 'viewer');
  assert.equal(state.senderId, a.id); assert.equal(state.members.length, 2);
});

test('invalid numeric configuration falls back and TTL is bounded', async t => {
  const f = await fixture(t, { TURN_HOST: 'localhost', TURN_SECRET: 'x', TURN_TTL_SECONDS: 'bad', TURN_PORT: 'bad', MAX_VIEWERS: 'bad' });
  const data = await fetch(`${f.url}/api/turn-credentials`).then(r => r.json());
  assert(Number.isFinite(data.expireAt));
  assert(data.servers.some(s => s.urls.includes('turn:localhost:3478?transport=udp')));
  const lower = await fixture(t, { TURN_HOST: 'localhost', TURN_SECRET: 'x', TURN_TTL_SECONDS: '-30' });
  const bounded = await fetch(`${lower.url}/api/turn-credentials`).then(r => r.json());
  assert(Math.abs(bounded.expireAt - Math.floor(Date.now() / 1000) - 60) <= 2);
});


test('intercom relays only between participating opposite roles in the same room', async t => {
  const f = await fixture(t), s = await f.client(), v = await f.client(), other = await f.client();
  await f.join(s, 'sender'); await f.join(v, 'viewer'); await f.join(other, 'viewer');
  const set = async (socket, enabled) => {
    const state = event(s, 'room:state', p => p.members.some(m => m.peerId === socket.id && m.intercom === enabled));
    socket.emit('intercom:toggle', enabled); await state;
  };
  const payload = { channel: 'intercom', kind: 'offer', sessionId: 'talk', sdp: { type: 'offer', sdp: 'audio-only' } };
  const received = []; v.on('room:signal', p => received.push(p));
  s.emit('room:message', { to: v.id, payload }); await pause(30); assert.equal(received.length, 0);
  await set(s, true); await set(v, true);
  let ready = event(v, 'room:signal'); s.emit('room:message', { to: v.id, payload });
  assert.equal((await ready).payload.channel, 'intercom');
  ready = event(s, 'room:signal');
  v.emit('room:message', { to: s.id, payload: { ...payload, kind: 'answer', sdp: { type: 'answer', sdp: 'audio-answer' } } });
  assert.equal((await ready).payload.channel, 'intercom');
  await set(v, false); const before = received.length;
  s.emit('room:message', { to: v.id, payload }); await pause(30); assert.equal(received.length, before);
  await set(v, true); await set(other, true);
  other.emit('room:message', { to: v.id, payload }); await pause(30); assert.equal(received.length, before);
});
