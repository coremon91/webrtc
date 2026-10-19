const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/main.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag = '') {
    this.tag = tag; this.children = []; this.events = {}; this.dataset = {};
    this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false;
    this.classList = { toggle() {}, remove() {} }; this.srcObject = null;
  }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  get firstElementChild() { return this.children[0]; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  querySelector(tag) { return this.children.find(child => child.tag === tag) || null; }
  addEventListener(name, callback) { this.events[name] = callback; }
  click() { return this.events.click?.(); }
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
}
function fixture(options = {}) {
  let clock = Date.now();
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const intervals = new Map(); let nextInterval = 0;
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const document = { getElementById: get, createElement: tag => new Element(tag),
    createTextNode: text => ({ textContent: text }), body: new Element(), documentElement: new Element() };
  for (const [id, value] of Object.entries({ resolution: '1280x720', fpsSelect: '30', bitrateKbps: '2500', sourceSelect: 'camera' })) get(id).value = value;
  get('audioEnabled').checked = true;
  let cameraCalls = 0, fetchCalls = 0, socket;
  const location = new URL('http://localhost:3000/?role=' + (options.role || 'sender') + (options.obs ? '&obs=1' : ''));
  const sent = [];
  const io = () => {
    const handlers = {};
    socket = { connected: false, id: 'self-1', handlers,
      on(name, fn) { handlers[name] = fn; },
      removeAllListeners() { for (const name of Object.keys(handlers)) delete handlers[name]; },
      connect() { this.connected = true; queueMicrotask(() => handlers.connect?.()); },
      disconnect() { this.connected = false; handlers.disconnect?.('io client disconnect'); },
      emit(name, packet) {
        sent.push({ name, packet });
        if (name === 'room:join') handlers['room:joined']?.({ room: packet.room, selfId: this.id,
          members: [{ peerId: this.id, name: packet.name, role: packet.role }], viewerCount: packet.role === 'viewer' ? 1 : 0, senderId: packet.role === 'sender' ? this.id : null });
      }
    };
    return socket;
  };
  const pcs = [];
  class PeerConnection {
    constructor() { this.connectionState = 'new'; this.signalingState = 'stable'; this.tracks = []; pcs.push(this); }
    addTrack(track) { this.tracks.push(track); }
    async createOffer() { return { type: 'offer', sdp: 'audio-offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'audio-answer' }; }
    async setLocalDescription(sdp) { this.localDescription = { ...sdp, toJSON: () => sdp }; this.signalingState = sdp.type === 'offer' ? 'have-local-offer' : 'stable'; }
    async setRemoteDescription(sdp) { this.remoteDescription = sdp; }
    async addIceCandidate() {}
    close() { this.connectionState = 'closed'; }
  }
  const context = vm.createContext({ document, location, URL, URLSearchParams, io, RTCPeerConnection: PeerConnection, crypto: require('node:crypto').webcrypto,
    window: { isSecureContext: true, addEventListener() {}, prompt() {} },
    navigator: { mediaDevices: { getUserMedia() { cameraCalls++; return options.media?.() || Promise.reject(new Error('No camera')); } } },
    fetch: async () => { fetchCalls++; return { status: options.authFailure ? 401 : 200, ok: !options.authFailure,
      json: async () => ({ servers: [{ urls: ['stun:localhost'] }], turnConfigured: true, expireAt: Math.floor(clock / 1000) + 60 }) }; },
    Date: ClockDate, AbortController, setTimeout, clearTimeout,
    setInterval: fn => { intervals.set(++nextInterval, fn); return nextInterval; }, clearInterval: id => intervals.delete(id), queueMicrotask, console
  });
  vm.runInContext(source, context);
  return { get, sent, pcs, advance: ms => { clock += ms; }, poll: async () => { for (const fn of intervals.values()) await fn(); },
    get socket() { return socket; }, get cameraCalls() { return cameraCalls; }, get fetchCalls() { return fetchCalls; } };
}
function stream() {
  const video = { kind: 'video', stopped: false, stop() { this.stopped = true; }, addEventListener() {}, getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }) };
  return { video, getTracks: () => [video], getVideoTracks: () => [video], getAudioTracks: () => [] };
}

test('Viewer joins without requesting a camera and Leave remains usable', async t => {
  const f = fixture({ role: 'viewer' }); t.after(() => f.get('btn-leave').click());
  await f.get('btn-join').click(); await tick();
  assert.equal(f.cameraCalls, 0);
  assert.equal(f.sent.filter(e => e.name === 'room:join').length, 1);
  assert.equal(f.get('btn-leave').disabled, false);
  f.get('btn-leave').click();
  assert.equal(f.get('btn-join').disabled, false); assert.equal(f.socket.connected, false);
});

test('leaving during a pending camera prompt stops the late stream and never joins', async () => {
  let resolveMedia;
  const f = fixture({ media: () => new Promise(resolve => { resolveMedia = resolve; }) });
  const pending = f.get('btn-join').click(); await tick();
  assert.equal(f.cameraCalls, 1); assert.equal(f.get('btn-leave').disabled, false);
  f.get('btn-leave').click(); const late = stream(); resolveMedia(late); await pending;
  assert.equal(late.video.stopped, true); assert.equal(f.socket, undefined); assert.equal(f.get('mainVideo').srcObject, null);
});

test('reconnect fetches fresh ICE and rejoins with new socket id', async t => {
  const f = fixture({ role: 'viewer' }); t.after(() => f.get('btn-leave').click());
  await f.get('btn-join').click(); await tick();
  const before = f.fetchCalls;
  f.socket.connected = false; f.socket.handlers.disconnect('transport close');
  assert.equal(f.get('btn-leave').disabled, false);
  f.socket.id = 'self-2'; f.socket.connect(); await tick();
  assert(f.fetchCalls > before); assert.equal(f.sent.filter(e => e.name === 'room:join').length, 2);
  assert.equal(f.get('status').textContent, '송출 대기');
});

test('bad access key fails before capture and releases start controls', async () => {
  const f = fixture({ authFailure: true }); await f.get('btn-join').click();
  assert.equal(f.cameraCalls, 0); assert.equal(f.get('btn-join').disabled, false);
  assert.equal(f.get('btn-leave').disabled, true); assert.equal(f.socket, undefined);
  assert.match(f.get('statusDetail').textContent, /접속 키/);
});

test('60-second TURN credentials refresh once near expiry without a two-second reconnect loop', async t => {
  const media = stream(); const f = fixture({ media: async () => media }); t.after(() => f.get('btn-leave').click());
  await f.get('btn-join').click(); await tick(); const before = f.fetchCalls;
  f.advance(2000); await f.poll(); assert.equal(f.fetchCalls, before);
  f.advance(42000); await f.poll(); assert.equal(f.fetchCalls, before);
  f.advance(2000); await f.poll(); assert.equal(f.fetchCalls, before + 1);
  await f.poll(); assert.equal(f.fetchCalls, before + 1);
});

function microphone() {
  const track = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}

test('intercom is opt-in, microphone toggles, and disabling releases capture', async t => {
  const mic = microphone(), f = fixture({ role: 'viewer', media: async () => mic });
  t.after(() => f.get('btn-leave').click());
  await f.get('btn-join').click(); await tick();
  assert.equal(f.cameraCalls, 0);
  await f.get('btn-intercom').click();
  assert.equal(f.cameraCalls, 1);
  assert(f.sent.some(e => e.name === 'intercom:toggle' && e.packet === true));
  f.get('btn-intercom-mute').click(); assert.equal(mic.track.enabled, false);
  f.get('btn-intercom-mute').click(); assert.equal(mic.track.enabled, true);
  await f.get('btn-intercom').click(); assert.equal(mic.track.stopped, true);
  assert.equal(f.sent.at(-1).packet, false);
});

test('cancelled intercom permission stops a late microphone without advertising participation', async t => {
  let resolve;
  const f = fixture({ role: 'viewer', media: () => new Promise(r => { resolve = r; }) });
  t.after(() => f.get('btn-leave').click());
  await f.get('btn-join').click(); await tick();
  const pending = f.get('btn-intercom').click();
  await f.get('btn-intercom').click();
  const mic = microphone(); resolve(mic); await pending;
  assert.equal(mic.track.stopped, true);
  assert(!f.sent.some(e => e.name === 'intercom:toggle' && e.packet === true));
});

test('intercom answer uses separate audio peer and disconnect releases microphone', async t => {
  const mic = microphone(), f = fixture({ role: 'viewer', media: async () => mic });
  t.after(() => f.get('btn-leave').click());
  await f.get('btn-join').click(); await tick();
  await f.get('btn-intercom').click();
  f.socket.handlers['room:state']({ room: 'studio', senderId: 'sender', viewerCount: 1, members: [
    { peerId: 'self-1', role: 'viewer', intercom: true }, { peerId: 'sender', role: 'sender', intercom: true }
  ] });
  f.socket.handlers['room:signal']({ from: 'sender', payload: { channel: 'intercom', kind: 'offer', sessionId: 'talk-1', sdp: { type: 'offer', sdp: 'audio' } } });
  await tick();
  assert.equal(f.pcs.length, 1); assert.equal(f.pcs[0].tracks[0], mic.track);
  assert.equal(f.get('mainVideo').srcObject, null);
  assert(f.sent.some(e => e.packet?.payload?.channel === 'intercom' && e.packet.payload.kind === 'answer'));
  f.socket.handlers.disconnect('transport close');
  assert.equal(mic.track.stopped, true); assert.equal(f.pcs[0].connectionState, 'closed');
});

test('microphone rejection leaves video session usable and OBS never captures intercom', async t => {
  const f = fixture({ role: 'viewer' }); t.after(() => f.get('btn-leave').click());
  await f.get('btn-join').click(); await tick(); await f.get('btn-intercom').click();
  assert.match(f.get('intercomStatus').textContent, /마이크 사용 실패/);
  assert.equal(f.socket.connected, true); assert.equal(f.get('btn-intercom').disabled, false);
  const obs = fixture({ obs: true }); t.after(() => obs.get('btn-leave').click());
  await tick(); await obs.get('btn-intercom').click();
  assert.equal(obs.cameraCalls, 0); assert.equal(obs.get('btn-intercom').disabled, true);
});
