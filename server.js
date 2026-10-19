'use strict';
require('dotenv').config();
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function integer(value, fallback, min, max) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function createServer(env = process.env) {
  const maxViewers = integer(env.MAX_VIEWERS, 10, 1, 100);
  const accessKey = typeof env.ACCESS_KEY === 'string' ? env.ACCESS_KEY.trim() : '';
  const allowedOrigins = (env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const turnHost = (env.TURN_HOST || '').trim();
  const turnSecret = (env.TURN_SECRET || '').trim();
  const turnPort = integer(env.TURN_PORT, 3478, 1, 65535);
  const turnTlsPort = integer(env.TURN_TLS_PORT, 0, 0, 65535);
  const ttl = integer(env.TURN_TTL_SECONDS, 3600, 60, 86400);
  const auth = token => !accessKey || (typeof token === 'string' && token.length <= 4096 &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(token).digest(), crypto.createHash('sha256').update(accessKey).digest()));
  const originAllowed = req => {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (allowedOrigins.length) return allowedOrigins.includes(origin);
    try { return ['http:', 'https:'].includes(new URL(origin).protocol) && new URL(origin).host === req.headers.host; }
    catch { return false; }
  };
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false, credentials: false }));
  app.use((_req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
  app.get('/api/turn-credentials', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!auth(token)) return res.status(401).json({ error: '접속 키가 올바르지 않습니다.' });
    const servers = [{ urls: ['stun:stun.l.google.com:19302'] }];
    const configured = Boolean(turnHost && turnSecret);
    let expireAt = null;
    if (configured) {
      expireAt = Math.floor(Date.now() / 1000) + ttl;
      const username = String(expireAt);
      const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
      const host = turnHost.includes(':') && !turnHost.startsWith('[') ? `[${turnHost}]` : turnHost;
      const urls = [`turn:${host}:${turnPort}?transport=udp`, `turn:${host}:${turnPort}?transport=tcp`];
      if (turnTlsPort) urls.push(`turns:${host}:${turnTlsPort}?transport=tcp`);
      servers.push({ urls, username, credential });
    }
    res.json({ servers, turnConfigured: configured, expireAt, ...(configured ? {} : { warning: 'TURN 미설정: 일부 외부 네트워크에서 연결되지 않을 수 있습니다.' }) });
  });
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 256 * 1024,
    cors: { origin: allowedOrigins.length ? allowedOrigins : false, credentials: false },
    allowRequest: (req, callback) => callback(null, originAllowed(req))
  });
  const rooms = new Map();
  const namespace = name => `broadcast:${name}`;
  function statePacket(room) {
    const state = rooms.get(room);
    const members = state ? [...state.members.values()] : [];
    return { room, members, senderId: state?.senderId || null, viewerCount: members.filter(m => m.role === 'viewer').length };
  }
  function broadcast(room) { io.to(namespace(room)).emit('room:state', statePacket(room)); }
  function leave(socket) {
    const name = socket.data.room;
    if (!name) return;
    socket.leave(namespace(name));
    delete socket.data.room;
    delete socket.data.role;
    delete socket.data.name;
    const state = rooms.get(name);
    if (!state) return;
    state.members.delete(socket.id);
    if (state.senderId === socket.id) state.senderId = null;
    if (!state.members.size) rooms.delete(name);
    else broadcast(name);
  }
  io.use((socket, next) => {
    if (auth(socket.handshake.auth?.accessKey)) return next();
    const error = new Error('접속 키가 올바르지 않습니다. (Unauthorized)');
    error.data = { code: 'unauthorized' };
    next(error);
  });
  io.on('connection', socket => {
    let signalWindow = Date.now(), signalCount = 0;
    socket.on('intercom:toggle', enabled => {
      const member = rooms.get(socket.data.room)?.members.get(socket.id);
      if (!member || typeof enabled !== 'boolean' || member.intercom === enabled) return;
      member.intercom = enabled;
      broadcast(socket.data.room);
    });
    socket.on('room:join', packet => {
      const reject = (code, message) => socket.emit('room:rejected', { code, message });
      if (!isRecord(packet) || (packet.room !== undefined && typeof packet.room !== 'string') ||
          (packet.name !== undefined && typeof packet.name !== 'string') || !['sender', 'viewer'].includes(packet.role)) {
        return reject('invalid-request', '입장 요청 형식이 올바르지 않습니다.');
      }
      const room = (packet.room || '').trim() || 'studio';
      const name = (packet.name || '').trim() || 'anonymous';
      const role = packet.role;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(room) || name.length > 60) return reject('invalid-request', '방 이름은 영문·숫자·_·- 64자, 이름은 60자 이내로 입력하세요.');
      let state = rooms.get(room);
      if (role === 'sender' && state?.senderId && state.senderId !== socket.id) return reject('sender-exists', '이미 송출 중인 Sender가 있습니다. 기존 송출을 종료한 뒤 다시 시도하세요.');
      if (role === 'viewer' && state && [...state.members.values()].filter(m => m.role === 'viewer' && m.peerId !== socket.id).length >= maxViewers) return reject('room-full', `Viewer 정원(${maxViewers}명)이 가득 찼습니다.`);
      if (socket.data.room === room && socket.data.role === role) {
        socket.emit('room:joined', { ...statePacket(room), selfId: socket.id });
        return;
      }
      leave(socket);
      state = rooms.get(room);
      if (!state) { state = { senderId: null, members: new Map() }; rooms.set(room, state); }
      state.members.set(socket.id, { peerId: socket.id, name, role, joinedAt: Date.now() });
      if (role === 'sender') state.senderId = socket.id;
      Object.assign(socket.data, { room, role, name });
      socket.join(namespace(room));
      socket.emit('room:joined', { ...statePacket(room), selfId: socket.id });
      broadcast(room);
    });
    socket.on('room:message', packet => {
      if (!isRecord(packet) || typeof packet.to !== 'string' || !isRecord(packet.payload) || !socket.data.room) return;
      if (Date.now() - signalWindow >= 1000) { signalWindow = Date.now(); signalCount = 0; }
      if (++signalCount > 200) return;
      const state = rooms.get(socket.data.room);
      const source = state?.members.get(socket.id), targetMember = state?.members.get(packet.to);
      const target = io.sockets.sockets.get(packet.to);
      if (!source || !targetMember || !target || target.data.room !== socket.data.room || source.role === targetMember.role) return;
      const p = packet.payload;
      if (p.channel !== undefined && p.channel !== 'intercom') return;
      if (p.channel === 'intercom' && (!source.intercom || !targetMember.intercom)) return;
      let payload;
      if (p.kind === 'retry' && source.role === 'viewer') payload = { kind: 'retry' };
      else {
        if (typeof p.sessionId !== 'string' || !p.sessionId.length || p.sessionId.length > 100) return;
        payload = { kind: p.kind, sessionId: p.sessionId };
        if ((p.kind === 'offer' && source.role === 'sender') || (p.kind === 'answer' && source.role === 'viewer')) {
          if (!isRecord(p.sdp) || p.sdp.type !== p.kind || typeof p.sdp.sdp !== 'string' || !p.sdp.sdp.length || p.sdp.sdp.length > 100000) return;
          payload.sdp = { type: p.kind, sdp: p.sdp.sdp };
        } else if (p.kind === 'candidate') {
          const c = p.data;
          if (!isRecord(c) || typeof c.candidate !== 'string' || c.candidate.length > 8192 ||
            (c.sdpMid != null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 256)) ||
            (c.sdpMLineIndex != null && (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 65535)) ||
            (c.usernameFragment != null && (typeof c.usernameFragment !== 'string' || c.usernameFragment.length > 256))) return;
          payload.data = { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null };
          if (typeof c.usernameFragment === 'string') payload.data.usernameFragment = c.usernameFragment;
          if (JSON.stringify(payload.data).length > 8192) return;
        } else return;
      }
      if (p.channel === 'intercom') payload.channel = 'intercom';
      target.emit('room:signal', { from: socket.id, name: source.name, payload });
    });
    socket.on('room:leave', () => leave(socket));
    socket.on('disconnect', () => leave(socket));
  });
  return { app, io, httpServer };
}
if (require.main === module) {
  const { httpServer, io } = createServer();
  const port = integer(process.env.PORT, 3000, 1, 65535);
  httpServer.listen(port, () => console.log(`FRAME WebRTC studio: http://localhost:${port}`));
  let closing = false;
  const close = () => { if (!closing) { closing = true; io.close(() => process.exit(0)); } };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
module.exports = { createServer };
