const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "kbcwebrtc";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const TURN_DOMAIN = String(process.env.TURN_DOMAIN || "").trim();
const TURN_SHARED_SECRET = String(process.env.TURN_SHARED_SECRET || "");
const requestedTurnTtl = Number.parseInt(process.env.TURN_TTL_SECONDS, 10) || 3600;
const TURN_TTL_SECONDS = Math.min(Math.max(requestedTurnTtl, 60), 86400);

const app = express();
app.use(express.json());

function isLocalhostAddress(addr) {
  if (!addr) return false;
  if (addr === "127.0.0.1" || addr === "::1") return true;
  if (String(addr).startsWith("::ffff:")) return String(addr).endsWith("127.0.0.1");
  return false;
}

function isLocalhostReq(req) {
  return isLocalhostAddress(req.socket && req.socket.remoteAddress);
}

function sendNotFound(res) {
  res.status(404).type("text/plain").send("Not Found");
}

function requireLocalhost(req, res, next) {
  if (!isLocalhostReq(req)) {
    return sendNotFound(res);
  }
  next();
}

function getLanIps() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n && n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
  return out;
}

function normalizeOrigin(raw, defaultScheme) {
  if (raw == null || !String(raw).trim()) return null;
  let s = String(raw).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = `${defaultScheme || "http"}://${s}`;
  return s;
}

function getPublicOrigin() {
  const fromEnv = normalizeOrigin(
    process.env.PUBLIC_ORIGIN || process.env.VISITOR_BASE_URL,
    "http"
  );
  if (fromEnv) return fromEnv;
  const ips = getLanIps();
  if (ips.length) return `http://${ips[0]}:${PORT}`;
  return `http://127.0.0.1:${PORT}`;
}

const DEFAULT_PUBLIC_HTTPS_ORIGIN = "https://kbcwebrtctest.gleeze.com";

/** 외부 HTTPS 시청 링크 (env PUBLIC_HTTPS_ORIGIN, 기본: gleeze 도메인) */
function getPublicHttpsOrigin() {
  return (
    normalizeOrigin(process.env.PUBLIC_HTTPS_ORIGIN || process.env.HTTPS_ORIGIN, "https") ||
    DEFAULT_PUBLIC_HTTPS_ORIGIN
  );
}

const sessions = new Map();

function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function ensureSession(req, res) {
  const cookies = parseCookieHeader(req.headers.cookie);
  let sid = cookies.sid;
  let session = sid ? sessions.get(sid) : null;
  if (!session) {
    sid = crypto.randomBytes(18).toString("hex");
    session = { id: sid, isAdmin: false, allowedRooms: new Set() };
    sessions.set(sid, session);
    res.setHeader(
      "Set-Cookie",
      `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`
    );
  }
  return session;
}

app.use((req, res, next) => {
  req.session = ensureSession(req, res);
  next();
});

const rooms = new Map();

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) {
    return res.status(401).json({ ok: false, error: "admin login required" });
  }
  next();
}

app.post("/api/login", requireLocalhost, (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "invalid credentials" });
});

app.post("/api/logout", requireLocalhost, (req, res) => {
  req.session.isAdmin = false;
  req.session.allowedRooms.clear();
  res.json({ ok: true });
});

app.get("/api/me", requireLocalhost, (req, res) => {
  res.json({
    ok: true,
    isAdmin: !!req.session.isAdmin,
    adminUser: req.session.isAdmin ? ADMIN_USER : null,
  });
});

app.get("/api/admin/config", requireLocalhost, requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    publicOrigin: getPublicOrigin(),
    publicHttpsOrigin: getPublicHttpsOrigin(),
    lanIps: getLanIps(),
  });
});

app.post("/api/rooms", requireLocalhost, requireAdmin, (req, res) => {
  const { password, title } = req.body || {};
  const roomId = crypto.randomBytes(16).toString("hex");
  const trimmedPass = password != null ? String(password).trim() : "";
  rooms.set(roomId, {
    password: trimmedPass || null,
    title:
      (title && String(title).trim()) || `Room ${roomId.slice(0, 8)}`,
    senderSocketId: null,
    viewers: new Set(),
    createdAt: Date.now(),
  });
  req.session.allowedRooms.add(roomId);
  const room = rooms.get(roomId);
  res.json({
    ok: true,
    room: {
      roomId,
      title: room.title,
      hasPassword: !!room.password,
      createdAt: room.createdAt,
    },
  });
});

app.get("/api/rooms", requireLocalhost, requireAdmin, (_req, res) => {
  const list = [];
  rooms.forEach((room, id) => {
    list.push({
      roomId: id,
      title: room.title,
      hasPassword: !!room.password,
      senderActive: !!room.senderSocketId,
      viewerCount: room.viewers.size,
      createdAt: room.createdAt,
    });
  });
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ ok: true, rooms: list });
});

app.delete("/api/rooms/:roomId", requireLocalhost, requireAdmin, (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ ok: false, error: "room not found" });

  if (room.senderSocketId) {
    io.to(room.senderSocketId).emit("kicked", { reason: "Room removed by admin." });
  }
  io.to(roomId).emit("room_closed", { roomId });
  io.to(roomId).emit("sender_left", { roomId });
  rooms.delete(roomId);
  sessions.forEach((s) => s.allowedRooms.delete(roomId));
  res.json({ ok: true });
});

app.get("/api/rooms/:roomId/info", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "room not found" });
  const { roomId } = req.params;
  const isAllowed =
    !!req.session.isAdmin || req.session.allowedRooms.has(roomId);
  const allowAdminViewerAuth = isLocalhostReq(req);
  res.json({
    ok: true,
    roomId,
    title: room.title,
    hasPassword: !!room.password,
    isAllowed,
    allowAdminViewerAuth,
    senderActive: !!room.senderSocketId,
    viewerCount: room.viewers.size,
  });
});

app.post("/api/rooms/:roomId/auth", (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ ok: false, error: "room not found" });

  const { mode, username, password, roomPassword } = req.body || {};

  if (mode === "admin" || (username && password)) {
    if (!isLocalhostReq(req)) {
      return sendNotFound(res);
    }
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      req.session.isAdmin = true;
      req.session.allowedRooms.add(roomId);
      return res.json({ ok: true, mode: "admin" });
    }
    return res.status(401).json({ ok: false, error: "invalid admin login" });
  }

  if (room.password) {
    if (!roomPassword || String(roomPassword) !== room.password) {
      return res.status(401).json({ ok: false, error: "wrong room password" });
    }
  }
  req.session.allowedRooms.add(roomId);
  res.json({ ok: true, mode: "room" });
});

function getTurnHost() {
  if (!TURN_DOMAIN) return null;
  const value = TURN_DOMAIN.replace(/^turns?:\/\//i, "").replace(/\/+$/, "");
  if (!/^[a-z0-9.-]+$/i.test(value)) return null;
  return value;
}

app.get("/api/rooms/:roomId/turn-credentials", (req, res) => {
  const { roomId } = req.params;
  if (!rooms.has(roomId)) {
    return res.status(404).json({ ok: false, error: "room not found" });
  }
  if (!req.session.isAdmin && !req.session.allowedRooms.has(roomId)) {
    return res.status(401).json({ ok: false, error: "room authorization required" });
  }

  const turnHost = getTurnHost();
  if (!turnHost || !TURN_SHARED_SECRET) {
    return res.status(503).json({ ok: false, error: "TURN service is not configured" });
  }

  const expiresAt = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
  const sessionId = req.session.id || crypto.randomBytes(18).toString("hex");
  const identity = crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  const username = `${expiresAt}:${identity}`;
  const credential = crypto
    .createHmac("sha1", TURN_SHARED_SECRET)
    .update(username)
    .digest("base64");

  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    ttl: TURN_TTL_SECONDS,
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: [
          `turn:${turnHost}:3478?transport=udp`,
          `turn:${turnHost}:3478?transport=tcp`,
          `turns:${turnHost}:5349?transport=tcp`,
        ],
        username,
        credential,
      },
    ],
  });
});

app.get("/", requireLocalhost, (req, res) => {
  if (req.session.isAdmin) return res.redirect("/admin");
  res.redirect("/login");
});

app.get("/login", requireLocalhost, (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "login.html"))
);

app.get("/admin", requireLocalhost, (req, res) => {
  if (!req.session.isAdmin) {
    return res.redirect("/login?next=" + encodeURIComponent("/admin"));
  }
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/publish/:roomId", requireLocalhost, (req, res) => {
  const { roomId } = req.params;
  if (!rooms.has(roomId)) return sendNotFound(res);
  if (!req.session.isAdmin) {
    return res.redirect(
      "/login?next=" + encodeURIComponent(`/publish/${roomId}`)
    );
  }
  res.sendFile(path.join(__dirname, "views", "sender.html"));
});

app.get("/watch/:roomId", (req, res) => {
  const { roomId } = req.params;
  if (!rooms.has(roomId)) return sendNotFound(res);
  res.sendFile(path.join(__dirname, "views", "viewer.html"));
});

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const base = path.basename(req.path || "");
  if (
    (base === "admin.html" || base === "login.html") &&
    !isLocalhostReq(req)
  ) {
    return sendNotFound(res);
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
let io;
io = new Server(server);

io.use((socket, next) => {
  const cookies = parseCookieHeader(socket.handshake.headers.cookie);
  const sid = cookies.sid;
  const session = sid ? sessions.get(sid) : null;
  socket.data.sid = sid || null;
  socket.data.session = session || null;
  next();
});

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("room_state", {
    roomId,
    senderPresent: !!room.senderSocketId,
    viewerCount: room.viewers.size,
  });
}

io.on("connection", (socket) => {
  console.log(`[socket] connect id=${socket.id.slice(0, 8)}`);

  socket.on("join", ({ roomId, role }) => {
    const rid = roomId ? String(roomId).slice(0, 8) : "?";
    if (!roomId || !role) {
      console.log(`[socket] join REJECT id=${socket.id.slice(0, 8)} (missing roomId/role)`);
      return;
    }

    const session = socket.data.session;
    if (!session) {
      console.log(`[socket] join REJECT viewer/sender room=${rid} — no session cookie`);
      socket.emit("kicked", { reason: "No session. Please log in or enter the room password." });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      console.log(`[socket] join REJECT room=${rid} — not in memory (restart?)`);
      socket.emit("kicked", { reason: "Room not found." });
      return;
    }

    if (role === "sender") {
      if (!session.isAdmin) {
        console.log(`[socket] join REJECT sender room=${rid} — not admin`);
        socket.emit("kicked", { reason: "Only the admin can publish." });
        return;
      }
    } else if (role === "viewer") {
      if (!session.isAdmin && !session.allowedRooms.has(roomId)) {
        console.log(`[socket] join REJECT viewer room=${rid} — not authorized (auth on same URL?)`);
        socket.emit("kicked", { reason: "Not authorized for this room." });
        return;
      }
    } else {
      return;
    }

    socket.data.roomId = roomId;
    socket.data.role = role;
    socket.join(roomId);

    if (role === "sender") {
      const previous = room.senderSocketId;
      room.senderSocketId = socket.id;
      if (previous && previous !== socket.id) {
        io.to(previous).emit("kicked", {
          reason: "Another sender joined (publish 탭 하나만).",
          duplicateSender: true,
        });
      }
      socket.emit("joined", { roomId, role, senderPresent: true });
      console.log(
        `[socket] join OK sender room=${rid} viewers=${room.viewers.size}`
      );
      broadcastRoomState(roomId);
      for (const viewerSocketId of room.viewers) {
        io.to(socket.id).emit("viewer_joined", { roomId, viewerSocketId });
      }
      return;
    }

    if (role === "viewer") {
      room.viewers.add(socket.id);
      const senderPresent = !!room.senderSocketId;
      socket.emit("joined", { roomId, role, senderPresent });
      console.log(
        `[socket] join OK viewer room=${rid} sender=${senderPresent ? "on" : "off"} viewers=${room.viewers.size}`
      );
      const notifySender = () => {
        if (!room.senderSocketId) return;
        io.to(room.senderSocketId).emit("viewer_joined", {
          roomId,
          viewerSocketId: socket.id,
        });
      };
      notifySender();
      setTimeout(notifySender, 800);
      broadcastRoomState(roomId);
    }
  });

  socket.on("sender_stop", ({ roomId }) => {
    if (!roomId || socket.data.roomId !== roomId || socket.data.role !== "sender") return;
    const room = rooms.get(roomId);
    if (!room || room.senderSocketId !== socket.id) return;
    room.senderSocketId = null;
    broadcastRoomState(roomId);
    io.to(roomId).emit("sender_left", { roomId });
  });

  socket.on("signal", (payload) => {
    const { roomId, to } = payload || {};
    if (!roomId || !to) return;
    if (socket.data.roomId !== roomId) return;
    io.to(to).emit("signal", { ...payload, from: socket.id });
  });

  socket.on("disconnect", (reason) => {
    const { roomId, role } = socket.data || {};
    if (!roomId || !role) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (role === "sender" && room.senderSocketId === socket.id) {
      room.senderSocketId = null;
      broadcastRoomState(roomId);
      io.to(roomId).emit("sender_left", { roomId });
      return;
    }

    if (role === "viewer") {
      room.viewers.delete(socket.id);
      if (room.senderSocketId) {
        io.to(room.senderSocketId).emit("viewer_left", {
          roomId,
          viewerSocketId: socket.id,
        });
      }
      broadcastRoomState(roomId);
    }
  });
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(`Signaling server listening on http://${displayHost}:${PORT}`);
  if (!getTurnHost() || !TURN_SHARED_SECRET) {
    console.warn(
      "[turn] TURN_DOMAIN or TURN_SHARED_SECRET is missing; WebRTC joins will be rejected."
    );
  }
  console.log(
    `관리자 UI는 이 PC에서만: http://localhost:${PORT}/login  (${ADMIN_USER} / ${ADMIN_PASS})`
  );
  const ips = getLanIps();
  if (ips.length)
    console.log(
      `LAN 시청 예: ${ips.map((ip) => `http://${ip}:${PORT}/watch/<roomId>`).join("  ")}`
    );
  const httpsOrigin = getPublicHttpsOrigin();
  console.log(`HTTPS 시청 예: ${httpsOrigin}/watch/<roomId>`);
});
