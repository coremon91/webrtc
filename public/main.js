'use strict';
(() => {
  const ids = ['roleSelect','roomName','userName','accessKey','sourceSelect','resolution','fpsSelect','bitrateKbps','audioEnabled','btn-join','btn-leave','btn-apply','btn-mute','btn-fullscreen','btn-play','btn-copy-viewer','btn-copy-obs','btn-clear-log','status','statusDetail','viewerCount','peerCount','actualSettings','transferStats','viewerList','logs','mainVideo','waitingStatus','btn-intercom','btn-intercom-mute','btn-intercom-play','intercomStatus','intercomAudio'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const query = new URLSearchParams(location.search);
  const obs = query.get('obs') === '1';
  const relay = query.get('relay') === '1';
  let active = null, nextRun = 0;
  ui.roleSelect.value = obs || query.get('role') === 'viewer' ? 'viewer' : 'sender';
  ui.roomName.value = query.get('room') || 'studio';
  ui.userName.value = query.get('name') || '';
  ui.accessKey.value = new URLSearchParams(location.hash.slice(1)).get('key') || '';
  document.documentElement.classList.toggle('obs-mode', obs);
  const current = run => active === run;
  const peerCurrent = (run, peer) => current(run) && run.joined && !peer.closed && run.peers.get(peer.id) === peer;
  function talkUI(run) {
    const talk = run?.talk;
    ui['btn-intercom'].disabled = obs || !run?.joined;
    ui['btn-intercom'].textContent = talk?.pending ? '마이크 요청 취소' : talk?.stream ? '인터컴 끄기' : '인터컴 켜기';
    ui['btn-intercom'].ariaPressed = String(Boolean(talk?.stream));
    ui['btn-intercom-mute'].disabled = !talk?.stream;
    ui['btn-intercom-mute'].textContent = talk?.muted ? '인터컴 마이크 켜기' : '인터컴 마이크 끄기';
    const count = talk ? [...talk.peers.values()].filter(p => p.pc.connectionState === 'connected').length : 0;
    ui.intercomStatus.textContent = talk?.pending ? '마이크 권한 대기' : !talk?.stream ? '꺼짐' : talk.muted ? '마이크 꺼짐' : count ? `통화 중 · ${count}명` : '상대방의 인터컴 참여 대기';
  }
  function closeTalkPeer(run, peer) {
    if (!peer) return;
    peer.pc.ontrack = peer.pc.onicecandidate = peer.pc.onconnectionstatechange = null;
    peer.pc.close(); peer.audio?.pause(); if (peer.audio) peer.audio.srcObject = null;
    peer.audio?.remove(); clearTimeout(peer.timer);
    if (run.talk.peers.get(peer.id) === peer) run.talk.peers.delete(peer.id);
  }
  function stopTalk(run, notify = true) {
    const talk = run.talk;
    talk.generation++; talk.pending = false;
    talk.stream?.getTracks().forEach(t => t.stop()); talk.stream = null; talk.muted = false;
    for (const p of [...talk.peers.values()]) closeTalkPeer(run, p);
    talk.starting.clear(); talk.early.clear();
    if (notify && run.socket?.connected && run.joined) run.socket.emit('intercom:toggle', false);
    ui['btn-intercom-play'].hidden = true;
    talkUI(current(run) ? run : null);
  }
  function talkCurrent(run, peer) {
    return current(run) && run.joined && run.talk.stream && run.talk.peers.get(peer.id) === peer;
  }
  function talkEmit(run, peer, payload) {
    if (talkCurrent(run, peer)) run.socket.emit('room:message', { to: peer.id, payload: { ...payload, sessionId: peer.sessionId, channel: 'intercom' } });
  }
  async function playTalk(run, peer) {
    try { await peer.audio.play(); }
    catch { if (talkCurrent(run, peer)) ui['btn-intercom-play'].hidden = false; }
  }
  function talkPeer(run, id, sessionId) {
    const pc = new RTCPeerConnection({ iceServers: run.iceServers, iceTransportPolicy: relay ? 'relay' : 'all', bundlePolicy: 'max-bundle' });
    const peer = { id, pc, sessionId, candidates: run.talk.early.get(`${id}:${sessionId}`) || [] };
    run.talk.early.delete(`${id}:${sessionId}`);
    run.talk.peers.set(id, peer);
    run.talk.stream.getAudioTracks().forEach(track => pc.addTrack(track, run.talk.stream));
    pc.onicecandidate = e => { if (e.candidate) talkEmit(run, peer, { kind: 'candidate', data: e.candidate.toJSON() }); };
    pc.ontrack = e => {
      if (!talkCurrent(run, peer) || e.track.kind !== 'audio') return;
      if (!peer.audio) { peer.audio = document.createElement('audio'); peer.audio.autoplay = true; ui.intercomAudio.append(peer.audio); }
      peer.audio.srcObject = new MediaStream([e.track]); playTalk(run, peer);
    };
    pc.onconnectionstatechange = () => {
      if (!talkCurrent(run, peer)) return;
      clearTimeout(peer.timer);
      if (['failed', 'disconnected'].includes(pc.connectionState)) peer.timer = setTimeout(() => {
        if (!talkCurrent(run, peer)) return;
        closeTalkPeer(run, peer); talkUI(run);
        log('인터컴 연결이 끊겼습니다. 인터컴을 껐다 켜서 다시 연결하세요.', 'warn');
      }, pc.connectionState === 'failed' ? 0 : 8000);
      talkUI(run);
    };
    return peer;
  }
  async function startTalkPeer(run, id) {
    const talk = run.talk;
    if (!talk.stream || talk.peers.has(id) || talk.starting.has(id)) return;
    const generation = talk.generation; talk.starting.add(id);
    let peer;
    try {
      await refreshIce(run);
      if (!current(run) || !run.joined || generation !== talk.generation || !run.members.get(id)?.intercom) return;
      peer = talkPeer(run, id, crypto.randomUUID());
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      talkEmit(run, peer, { kind: 'offer', sdp: peer.pc.localDescription.toJSON() });
    } catch (e) {
      if (peer) closeTalkPeer(run, peer);
      if (current(run)) log(`인터컴 연결 실패: ${e.message}`, 'warn');
    } finally { if (generation === talk.generation) talk.starting.delete(id); }
  }
  function syncTalk(run) {
    for (const p of [...run.talk.peers.values()]) if (!run.members.get(p.id)?.intercom) closeTalkPeer(run, p);
    if (run.role === 'sender' && run.talk.stream) for (const m of run.members.values()) {
      if (m.role === 'viewer' && m.intercom) startTalkPeer(run, m.peerId);
    }
    talkUI(run);
  }
  async function talkSignal(run, { from, payload: p }) {
    if (obs || !run.talk.stream || !run.members.get(from)?.intercom || typeof p.sessionId !== 'string') return;
    let peer = run.talk.peers.get(from);
    if (p.kind === 'offer' && run.role === 'viewer') {
      if (peer?.sessionId === p.sessionId) return;
      closeTalkPeer(run, peer); peer = talkPeer(run, from, p.sessionId);
      await peer.pc.setRemoteDescription(p.sdp);
      if (!talkCurrent(run, peer)) return;
      for (const c of peer.candidates.splice(0)) await peer.pc.addIceCandidate(c);
      if (!talkCurrent(run, peer)) return;
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      talkEmit(run, peer, { kind: 'answer', sdp: peer.pc.localDescription.toJSON() });
    } else if (p.kind === 'answer' && run.role === 'sender' && peer?.sessionId === p.sessionId && peer.pc.signalingState === 'have-local-offer') {
      await peer.pc.setRemoteDescription(p.sdp);
      if (talkCurrent(run, peer)) for (const c of peer.candidates.splice(0)) await peer.pc.addIceCandidate(c);
    } else if (p.kind === 'candidate' && p.data) {
      if (peer?.sessionId === p.sessionId) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(p.data);
        else if (peer.candidates.length < 64) peer.candidates.push(p.data);
      } else {
        const key = `${from}:${p.sessionId}`, early = run.talk.early;
        if (!early.has(key)) { if (early.size >= 16) early.delete(early.keys().next().value); early.set(key, []); }
        if (early.get(key).length < 64) early.get(key).push(p.data);
      }
    }
  }
  async function toggleTalk() {
    const run = active;
    if (obs || !run?.joined) return;
    const talk = run.talk;
    if (talk.stream || talk.pending) { stopTalk(run); return; }
    const generation = ++talk.generation; talk.pending = true; talkUI(run);
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('마이크는 HTTPS 또는 localhost에서 사용할 수 있습니다.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!current(run) || !run.joined || generation !== talk.generation) { stream.getTracks().forEach(t => t.stop()); return; }
      if (!stream.getAudioTracks().length) { stream.getTracks().forEach(t => t.stop()); throw new Error('사용 가능한 마이크가 없습니다.'); }
      talk.stream = stream; talk.pending = false;
      stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => { if (current(run) && talk.stream === stream) stopTalk(run); }));
      run.socket.emit('intercom:toggle', true); syncTalk(run);
    } catch (e) {
      if (current(run) && generation === talk.generation) { stopTalk(run); ui.intercomStatus.textContent = `마이크 사용 실패: ${e.message}`; log(`인터컴: ${e.message}`, 'warn'); }
    }
  }
  function log(text, level = 'info') {
    const li = document.createElement('li'), time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    li.className = `log-${level}`;
    li.append(time, document.createTextNode(text));
    ui.logs.append(li);
    while (ui.logs.children.length > 120) ui.logs.firstElementChild.remove();
    ui.logs.scrollTop = ui.logs.scrollHeight;
  }
  function status(text, detail = '') { ui.status.textContent = text; ui.statusDetail.textContent = detail; }
  function waiting(text, visible = true) { ui.waitingStatus.textContent = text; ui.waitingStatus.hidden = !visible; }
  function mode() {
    if (obs) ui.roleSelect.value = 'viewer';
    document.body.dataset.role = ui.roleSelect.value;
    ui['btn-join'].textContent = ui.roleSelect.value === 'sender' ? '송출 시작' : '시청 시작';
    ui['btn-mute'].disabled = ui.roleSelect.value === 'sender';
  }
  function lock(running) {
    for (const id of ['roleSelect','roomName','userName','accessKey','sourceSelect','audioEnabled']) ui[id].disabled = running;
    ui['btn-join'].disabled = running;
    ui['btn-leave'].disabled = !running;
    ui['btn-apply'].disabled = !active?.joined || active.role !== 'sender';
    if (obs) ui.roleSelect.disabled = true;
    talkUI(active);
  }
  function settings() {
    const [width, height] = ui.resolution.value.split('x').map(Number);
    const fps = Number(ui.fpsSelect.value), kbps = Number(ui.bitrateKbps.value);
    if (![640,1280,1920].includes(width) || ![360,720,1080].includes(height) || ![15,24,30,60].includes(fps) || !Number.isFinite(kbps) || kbps < 150 || kbps > 20000) throw new Error('비트레이트는 150~20000 kbps로 입력하세요.');
    return { width, height, fps, kbps };
  }
  function actualFormat(run) {
    if (!current(run)) return;
    if (run.role === 'sender') {
      const s = run.local?.getVideoTracks()[0]?.getSettings() || {};
      ui.actualSettings.textContent = `${s.width || run.quality.width} × ${s.height || run.quality.height} · ${Math.round(s.frameRate || run.quality.fps)} FPS · 상한 ${run.quality.kbps} kbps / Viewer`;
    }
  }
  function testPattern(quality) {
    const canvas = document.createElement('canvas');
    canvas.width = quality.width; canvas.height = quality.height;
    const ctx = canvas.getContext('2d');
    const colors = ['#e9e9e9','#dfcf50','#52c7cb','#51b46e','#cf5d9d','#be5f50','#485dba'];
    function draw() {
      colors.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * canvas.width / 7, 0, canvas.width / 7 + 1, canvas.height); });
      ctx.fillStyle = '#0b1424'; ctx.fillRect(0, canvas.height * .62, canvas.width, canvas.height * .38);
      ctx.fillStyle = '#fff'; ctx.font = `600 ${canvas.width / 22}px sans-serif`; ctx.fillText('FRAME / LIVE TEST', canvas.width * .06, canvas.height * .76);
      ctx.font = `${canvas.width / 38}px monospace`; ctx.fillStyle = '#8eabc9';
      ctx.fillText(`${quality.width} x ${quality.height} / ${quality.fps} FPS`, canvas.width * .06, canvas.height * .85);
      ctx.fillText(new Date().toLocaleTimeString('ko-KR', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3,'0'), canvas.width * .06, canvas.height * .93);
      const x = ((Date.now() % 4000) / 4000) * canvas.width;
      ctx.fillStyle = '#fff'; ctx.fillRect(x, canvas.height * .58, canvas.width / 80, canvas.height * .04);
    }
    draw();
    const stream = canvas.captureStream(quality.fps);
    const timer = setInterval(draw, 1000 / quality.fps);
    return { stream, cleanup: () => clearInterval(timer) };
  }
  async function capture(run) {
    if (!window.isSecureContext) throw new Error('외부 카메라·화면 송출은 HTTPS 주소에서 열어주세요. 로컬은 localhost를 사용하세요.');
    const q = run.quality;
    if (run.source === 'test') {
      const test = testPattern(q); run.captureCleanup = test.cleanup;
      log('테스트 패턴 선택 · 오디오 없이 영상을 송출합니다.');
      return test.stream;
    }
    if (!navigator.mediaDevices) throw new Error('이 브라우저에서 미디어 장치를 사용할 수 없습니다.');
    const video = { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps } };
    if (run.source === 'screen') return navigator.mediaDevices.getDisplayMedia({ video, audio: run.audio });
    return navigator.mediaDevices.getUserMedia({ video, audio: run.audio ? { echoCancellation: true, noiseSuppression: true } : false });
  }
  async function refreshIce(run, force = false) {
    if (run.icePromise) return run.icePromise;
    if (!force && run.iceServers && Date.now() < run.iceRefreshAt) return;
    const promise = (async () => {
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10000);
      try {
        const headers = run.key ? { Authorization: `Bearer ${run.key}` } : {};
        const res = await fetch('/api/turn-credentials', { cache: 'no-store', headers, signal: abort.signal });
        if (res.status === 401) { const e = new Error('접속 키가 올바르지 않습니다.'); e.auth = true; throw e; }
        if (!res.ok) throw new Error(`ICE 설정 요청 실패 (${res.status})`);
        const data = await res.json();
        if (!Array.isArray(data.servers) || !data.servers.length) throw new Error('ICE 서버 목록이 비어 있습니다.');
        if (!current(run)) return;
        run.iceServers = data.servers; run.iceExpiry = data.expireAt;
        run.iceRefreshAt = data.expireAt ? Date.now() + Math.max(15000, (data.expireAt * 1000 - Date.now()) * .75) : Infinity;
        if (!data.turnConfigured) {
          if (relay) throw new Error('TURN이 설정되지 않아 relay 전용 연결을 시작할 수 없습니다.');
          log('TURN 미설정 · 일부 외부 네트워크에서 연결되지 않을 수 있습니다.', 'warn');
        }
      } catch (e) {
        if (e.auth || relay) throw e;
        if (current(run)) { run.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; run.iceExpiry = null; run.iceRefreshAt = Date.now() + 30000; log('ICE 설정을 받지 못해 STUN으로 연결을 시도합니다.', 'warn'); }
      } finally { clearTimeout(timer); }
    })();
    run.icePromise = promise;
    try { await promise; } finally { if (run.icePromise === promise) run.icePromise = null; }
  }
  function emit(run, peer, payload) {
    if (peerCurrent(run, peer) && run.socket.connected) run.socket.emit('room:message', { to: peer.id, payload });
  }
  function closePeer(run, peer) {
    if (!peer || peer.closed) return;
    peer.closed = true; clearTimeout(peer.retryTimer);
    peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = peer.pc.oniceconnectionstatechange = null;
    peer.pc.close();
    if (run.peers.get(peer.id) === peer) run.peers.delete(peer.id);
    for (const key of run.statsPrevious.keys()) if (key.startsWith(peer.sessionId + ':')) run.statsPrevious.delete(key);
  }
  function clearPeers(run) {
    [...run.peers.values()].forEach(p => closePeer(run, p));
    run.starting.clear(); run.early.clear(); run.chains.clear(); run.statsPrevious.clear();
    run.retryCounts.clear(); run.lastRetry.clear();
    ui.peerCount.textContent = '0';
    if (run.role === 'viewer') { ui.mainVideo.srcObject = null; ui['btn-play'].hidden = true; ui.actualSettings.textContent = '수신 영상을 기다리고 있습니다.'; ui.transferStats.textContent = '영상 연결 대기'; }
  }
  function connectionCount(run) {
    if (!current(run)) return;
    const count = [...run.peers.values()].filter(p => p.pc.connectionState === 'connected').length;
    ui.peerCount.textContent = String(count);
    for (const li of ui.viewerList.children) {
      const label = li.querySelector('small');
      if (label) label.textContent = run.peers.get(li.dataset.peerId)?.pc.connectionState === 'connected' ? '영상 연결' : '연결 대기';
    }
    document.body.classList.toggle('is-active', run.joined && (run.role === 'sender' || count > 0));
    if (run.role === 'viewer' && count) status('시청 중', 'Sender의 영상을 수신하고 있습니다.');
  }
  function retry(run, peer, delay = 2000) {
    if (!peerCurrent(run, peer) || peer.retryTimer) return;
    if (peer.attempt >= 3) { log('영상 연결 재시도 한도에 도달했습니다. 종료 후 다시 입장하세요.', 'error'); status('영상 연결 실패', 'TURN 설정과 네트워크를 확인하고 다시 입장하세요.'); return; }
    peer.retryTimer = setTimeout(() => {
      peer.retryTimer = null;
      if (!peerCurrent(run, peer)) return;
      if (run.role === 'sender') startSender(run, peer.id, peer.attempt + 1).catch(e => peerError(run, peer, e));
      else { peer.attempt++; run.retryCounts.set(peer.id, peer.attempt); emit(run, peer, { kind: 'retry' }); log('Sender에 영상 재연결을 요청했습니다.', 'warn'); }
    }, delay);
  }
  function peerError(run, peer, error) {
    if (!peerCurrent(run, peer)) return;
    log(`영상 연결 오류: ${error.message || '협상 실패'}`, 'warn'); retry(run, peer);
  }
  function newPeer(run, id, sessionId, attempt = 0) {
    const pc = new RTCPeerConnection({ iceServers: run.iceServers, iceTransportPolicy: relay ? 'relay' : 'all', bundlePolicy: 'max-bundle' });
    const peer = { id, sessionId, pc, candidates: [], attempt, closed: false, retryTimer: null };
    run.peers.set(id, peer);
    pc.onicecandidate = e => { if (e.candidate) emit(run, peer, { kind: 'candidate', data: e.candidate.toJSON(), sessionId }); };
    pc.onconnectionstatechange = () => {
      if (!peerCurrent(run, peer)) return;
      const state = pc.connectionState;
      log(`${run.members.get(id)?.name || '상대'} · 영상 ${state}`);
      if (state === 'connected') { clearTimeout(peer.retryTimer); peer.retryTimer = null; peer.attempt = 0; run.retryCounts.set(id, 0); }
      else if (state === 'failed') retry(run, peer);
      else if (state === 'disconnected') retry(run, peer, 8000);
      connectionCount(run);
    };
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') retry(run, peer); };
    if (run.role === 'viewer') pc.ontrack = e => {
      if (!peerCurrent(run, peer)) return;
      if (!peer.stream) peer.stream = e.streams[0] || new MediaStream();
      if (!peer.stream.getTracks().some(t => t.id === e.track.id)) peer.stream.addTrack(e.track);
      if (ui.mainVideo.srcObject !== peer.stream) ui.mainVideo.srcObject = peer.stream;
      play(run);
    };
    return peer;
  }
  async function encodings(run, peer) {
    if (!peerCurrent(run, peer)) return;
    for (const sender of peer.pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) { log('인코더 설정을 아직 적용할 수 없습니다. 협상 후 다시 적용합니다.', 'warn'); continue; }
      params.encodings.forEach(e => { e.maxBitrate = run.quality.kbps * 1000; e.maxFramerate = run.quality.fps; });
      params.degradationPreference = 'maintain-resolution';
      await sender.setParameters(params);
    }
  }
  async function flush(run, peer) {
    while (peer.candidates.length && peerCurrent(run, peer)) {
      const candidate = peer.candidates.shift();
      try { await peer.pc.addIceCandidate(candidate); }
      catch (e) { if (peerCurrent(run, peer)) log(`ICE 후보 처리 실패: ${e.message}`, 'warn'); }
    }
  }
  async function startSender(run, id, attempt = 0) {
    if (!current(run) || !run.joined || run.starting.has(id) || run.members.get(id)?.role !== 'viewer') return;
    if (attempt > 3) { log('영상 재연결 한도에 도달했습니다. 네트워크 확인 후 다시 입장하세요.', 'error'); return; }
    const ticket = Symbol(); run.starting.set(id, ticket);
    closePeer(run, run.peers.get(id));
    let peer;
    try {
      await refreshIce(run);
      if (!current(run) || !run.joined || run.starting.get(id) !== ticket || run.members.get(id)?.role !== 'viewer') return;
      peer = newPeer(run, id, crypto.randomUUID(), attempt);
      run.local.getTracks().forEach(track => peer.pc.addTrack(track, run.local));
      const offer = await peer.pc.createOffer(); if (!peerCurrent(run, peer)) return;
      await peer.pc.setLocalDescription(offer); if (!peerCurrent(run, peer)) return;
      emit(run, peer, { kind: 'offer', sdp: peer.pc.localDescription.toJSON(), sessionId: peer.sessionId });
      log(`${run.members.get(id)?.name || 'Viewer'}에게 영상 연결 요청`);
    } catch (e) { if (peer) peerError(run, peer, e); else if (current(run)) log(e.message, 'error'); }
    finally { if (run.starting.get(id) === ticket) run.starting.delete(id); }
  }
  async function signal(run, packet) {
    if (!current(run) || !run.joined || !packet?.payload) return;
    const { from, payload: p } = packet;
    const member = run.members.get(from);
    if (!member || member.role === run.role || (run.role === 'viewer' && from !== run.senderId)) return;
    if (p.channel === 'intercom') return talkSignal(run, packet);
    if (p.kind === 'retry' && run.role === 'sender') {
      const last = run.lastRetry.get(from) || 0;
      if (Date.now() - last < 1500) return;
      run.lastRetry.set(from, Date.now());
      return startSender(run, from, (run.peers.get(from)?.attempt || 0) + 1);
    }
    if (typeof p.sessionId !== 'string') return;
    let peer = run.peers.get(from);
    if (p.kind === 'offer' && run.role === 'viewer') {
      if (peer?.sessionId === p.sessionId) return;
      const generation = run.connectionGeneration;
      await refreshIce(run);
      if (!current(run) || !run.joined || generation !== run.connectionGeneration || from !== run.senderId) return;
      closePeer(run, peer);
      peer = newPeer(run, from, p.sessionId, run.retryCounts.get(from) || 0);
      peer.candidates = run.early.get(`${from}:${p.sessionId}`) || [];
      run.early.clear();
      await peer.pc.setRemoteDescription(p.sdp); if (!peerCurrent(run, peer)) return;
      await flush(run, peer); if (!peerCurrent(run, peer)) return;
      const answer = await peer.pc.createAnswer(); if (!peerCurrent(run, peer)) return;
      await peer.pc.setLocalDescription(answer);
      emit(run, peer, { kind: 'answer', sdp: peer.pc.localDescription.toJSON(), sessionId: p.sessionId });
    } else if (p.kind === 'answer' && run.role === 'sender' && peer?.sessionId === p.sessionId && peer.pc.signalingState === 'have-local-offer') {
      await peer.pc.setRemoteDescription(p.sdp); if (!peerCurrent(run, peer)) return;
      await flush(run, peer);
      try { await encodings(run, peer); }
      catch (e) { if (peerCurrent(run, peer)) log(`인코더 상한 적용 실패: ${e.message}. 영상 연결은 유지합니다.`, 'warn'); }
    } else if (p.kind === 'candidate' && p.data) {
      if (!peer || peer.sessionId !== p.sessionId) {
        if (run.role === 'viewer') {
          const key = `${from}:${p.sessionId}`;
          if (!run.early.has(key)) { if (run.early.size >= 4) run.early.delete(run.early.keys().next().value); run.early.set(key, []); }
          const list = run.early.get(key); if (list.length < 64) list.push(p.data);
        }
      } else if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(p.data);
      else if (peer.candidates.length < 64) peer.candidates.push(p.data);
    }
  }
  function members(run, packet) {
    if (!current(run) || !run.joined || packet.room !== run.room || !Array.isArray(packet.members)) return;
    const next = new Map(packet.members.map(m => [m.peerId, m]));
    for (const [id, m] of next) if (id !== run.selfId && !run.members.has(id)) log(`${m.name} 입장 · ${m.role}`);
    for (const [id, m] of run.members) if (id !== run.selfId && !next.has(id)) log(`${m.name} 퇴장`);
    const oldSender = run.senderId;
    run.members = next; run.senderId = packet.senderId;
    ui.viewerCount.textContent = String(packet.viewerCount || 0);
    ui.viewerList.replaceChildren();
    for (const m of next.values()) {
      if (m.role !== 'viewer') continue;
      const li = document.createElement('li'), name = document.createElement('span'), state = document.createElement('small');
      li.dataset.peerId = m.peerId;
      name.textContent = m.name; state.textContent = '방 접속'; li.append(name, state); ui.viewerList.append(li);
    }
    if (!ui.viewerList.children.length) { const li = document.createElement('li'); li.className = 'empty-list'; li.textContent = '아직 접속한 Viewer가 없습니다.'; ui.viewerList.append(li); }
    for (const peer of [...run.peers.values()]) if (!next.has(peer.id) || next.get(peer.id).role === run.role) closePeer(run, peer);
    if (run.role === 'sender') {
      for (const m of next.values()) if (m.role === 'viewer' && !run.peers.has(m.peerId)) startSender(run, m.peerId);
    } else if (!run.senderId || oldSender && oldSender !== run.senderId) {
      clearPeers(run); waiting('Sender의 송출을 기다리고 있습니다.'); status('송출 대기', '방에 접속했습니다. Sender가 시작하면 자동으로 재생됩니다.');
    }
    syncTalk(run); connectionCount(run);
  }
  async function play(run) {
    if (!current(run)) return;
    const ticket = run.playGeneration = (run.playGeneration || 0) + 1;
    const hasAudio = Boolean(ui.mainVideo.srcObject?.getAudioTracks().length);
    ui.mainVideo.muted = run.role === 'sender' || run.muted || !hasAudio;
    ui['btn-mute'].disabled = run.role === 'sender' || !hasAudio;
    try { await ui.mainVideo.play(); if (current(run) && ticket === run.playGeneration) { waiting('', false); ui['btn-play'].hidden = true; } }
    catch {
      if (!current(run) || ticket !== run.playGeneration) return;
      ui.mainVideo.muted = true; run.muted = true;
      await ui.mainVideo.play().catch(() => {});
      if (current(run) && ticket === run.playGeneration) ui['btn-play'].hidden = !hasAudio && !ui.mainVideo.paused;
    }
    if (current(run)) ui['btn-mute'].textContent = ui.mainVideo.muted ? '소리 켜기' : '소리 끄기';
  }
  async function stats(run) {
    if (!current(run) || run.statsBusy || !run.joined) return;
    run.statsBusy = true;
    try {
      let kbps = 0, fps = 0, width = 0, height = 0;
      const paths = new Set();
      for (const peer of run.peers.values()) {
        const reports = await peer.pc.getStats(); if (!peerCurrent(run, peer)) continue;
        const kind = run.role === 'sender' ? 'outbound-rtp' : 'inbound-rtp';
        reports.forEach(report => {
          if (report.type === kind && !report.isRemote && (report.kind === 'video' || report.mediaType === 'video')) {
            const bytes = run.role === 'sender' ? report.bytesSent : report.bytesReceived;
            const key = `${peer.sessionId}:${report.id}`, previous = run.statsPrevious.get(key);
            if (previous && report.timestamp > previous.time && bytes >= previous.bytes) kbps += (bytes - previous.bytes) * 8 / (report.timestamp - previous.time);
            run.statsPrevious.set(key, { time: report.timestamp, bytes });
            fps = Math.max(fps, report.framesPerSecond || 0); width = report.frameWidth || width; height = report.frameHeight || height;
          }
          if (report.type === 'transport' && report.selectedCandidatePairId) {
            const pair = reports.get(report.selectedCandidatePairId), local = pair && reports.get(pair.localCandidateId), remote = pair && reports.get(pair.remoteCandidateId);
            if (local || remote) paths.add(local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN relay' : '직접 연결');
          }
        });
      }
      if (!current(run)) return;
      ui.transferStats.textContent = `${Math.round(kbps)} kbps ${run.role === 'sender' ? '영상 업로드 합계' : '영상 수신'} · ${fps ? fps.toFixed(0) + ' FPS · ' : ''}${[...paths].join(' / ') || '연결 대기'}`;
      if (run.role === 'viewer' && (width || ui.mainVideo.videoWidth)) ui.actualSettings.textContent = `${width || ui.mainVideo.videoWidth} × ${height || ui.mainVideo.videoHeight} · ${fps ? fps.toFixed(0) + ' FPS' : 'FPS 측정 중'}`;
      if (run.role === 'sender' && run.iceExpiry && Date.now() >= run.iceRefreshAt) {
        await refreshIce(run, true);
        if (current(run)) { log('TURN 자격증명을 갱신하고 영상 연결을 갱신합니다.'); for (const id of [...run.peers.keys()]) startSender(run, id); }
      }
    } catch (e) { if (current(run)) log(`연결 측정 실패: ${e.message}`, 'warn'); }
    finally { run.statsBusy = false; }
  }
  function stop(message = '연결을 종료했습니다.') {
    const run = active; active = null;
    if (run) {
      stopTalk(run);
      run.joined = false; clearInterval(run.statsTimer); clearPeers(run);
      run.captureCleanup?.(); run.local?.getTracks().forEach(t => t.stop());
      run.socket?.removeAllListeners(); run.socket?.disconnect();
    }
    ui.mainVideo.srcObject = null; ui['btn-play'].hidden = true;
    document.body.classList.remove('is-active'); ui.viewerCount.textContent = '0'; ui.peerCount.textContent = '0';
    ui.viewerList.replaceChildren(); ui.actualSettings.textContent = '아직 연결된 영상이 없습니다.'; ui.transferStats.textContent = '실측 전송률을 기다리고 있습니다.';
    lock(false); mode(); status('대기', message); waiting(obs ? 'Sender의 송출을 기다리고 있습니다.' : message);
  }
  async function start() {
    if (active) return;
    let quality;
    try { quality = settings(); } catch (e) { status('설정 확인', e.message); log(e.message, 'error'); return; }
    const room = ui.roomName.value.trim() || 'studio';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(room)) { status('설정 확인', '방 이름은 영문·숫자·_·- 64자 이내로 입력하세요.'); return; }
    const run = { id: ++nextRun, role: ui.roleSelect.value, room, name: ui.userName.value.trim() || (obs ? 'OBS' : ui.roleSelect.value), key: ui.accessKey.value.trim(), source: ui.sourceSelect.value, audio: ui.audioEnabled.checked, quality, peers: new Map(), members: new Map(), starting: new Map(), early: new Map(), chains: new Map(), statsPrevious: new Map(), lastRetry: new Map(), retryCounts: new Map(), connectionGeneration: 0, joined: false, muted: false };
    run.talk = { peers: new Map(), early: new Map(), starting: new Set(), generation: 0, stream: null, pending: false, muted: false };
    active = run; lock(true); status('준비 중', '접속 설정을 확인하고 있습니다.');
    try {
      await refreshIce(run, true); if (!current(run)) return;
      if (run.role === 'sender') {
        status('소스 준비', '카메라·마이크 권한 또는 공유 화면을 확인하세요.');
        const stream = await capture(run);
        if (!current(run)) { stream.getTracks().forEach(t => t.stop()); run.captureCleanup?.(); return; }
        run.local = stream; ui.mainVideo.srcObject = stream; await play(run); actualFormat(run);
        stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => { if (current(run)) { log('영상 소스가 종료되었습니다.', 'warn'); stop('영상 소스가 종료되었습니다.'); } }));
      } else waiting('Sender의 송출을 기다리고 있습니다.');
      if (!current(run)) return;
      const socket = io({ autoConnect: false, auth: { accessKey: run.key }, reconnection: true }); run.socket = socket;
      socket.on('connect', async () => {
        const generation = ++run.connectionGeneration;
        if (!current(run)) return;
        clearPeers(run); run.joined = false; run.selfId = null; run.members.clear(); run.senderId = null;
        status('입장 중', '방에 연결하고 있습니다.');
        try {
          await refreshIce(run, true);
          if (current(run) && socket.connected && generation === run.connectionGeneration) socket.emit('room:join', { room: run.room, name: run.name, role: run.role });
        } catch (e) { if (current(run)) { log(e.message, 'error'); stop(e.message); status('입장 실패', e.message); } }
      });
      socket.on('room:joined', packet => {
        if (!current(run)) return;
        run.selfId = packet.selfId; run.joined = true; lock(true);
        status(run.role === 'sender' ? '송출 중' : '송출 대기', run.role === 'sender' ? 'Viewer가 입장하면 영상이 연결됩니다.' : '카메라·마이크 없이 영상을 시청합니다.');
        log(`${run.room} 방에 ${run.role}로 입장했습니다.`); members(run, packet);
      });
      socket.on('room:state', packet => members(run, packet));
      socket.on('room:signal', packet => {
        const generation = run.connectionGeneration;
        const chain = run.chains.get(packet.from) || Promise.resolve();
        const next = chain.then(() => { if (current(run) && generation === run.connectionGeneration) return signal(run, packet); }).catch(e => { if (current(run)) { const p = run.peers.get(packet.from); if (p) peerError(run, p, e); else log(`신호 처리 실패: ${e.message}`, 'warn'); } });
        run.chains.set(packet.from, next);
      });
      socket.on('room:rejected', packet => { if (current(run)) { log(packet.message, 'error'); stop(packet.message); status('입장 거부', packet.message); } });
      socket.on('disconnect', reason => {
        if (!current(run)) return;
        stopTalk(run, false);
        run.connectionGeneration++; run.joined = false; run.selfId = null; run.members.clear(); run.senderId = null; clearPeers(run); lock(true);
        ui.viewerCount.textContent = '0'; ui.viewerList.replaceChildren(); document.body.classList.remove('is-active');
        status('재접속 중', '서버 연결을 복구하고 있습니다. 종료 버튼으로 취소할 수 있습니다.'); log(`서버 연결 끊김 · ${reason}`, 'warn');
        if (run.role === 'viewer') waiting('연결을 복구하고 있습니다.');
        if (reason === 'io server disconnect') socket.connect();
      });
      socket.on('connect_error', e => {
        if (!current(run)) return;
        if (e.data?.code === 'unauthorized' || /Unauthorized/i.test(e.message)) { log('접속 키를 확인하세요.', 'error'); stop('접속 키를 확인하세요.'); status('인증 실패', '접속 키를 확인하고 다시 입장하세요.'); }
        else { status('재접속 중', '서버에 연결할 수 없습니다. 주소·네트워크를 확인하세요.'); log('서버 접속 실패 · 자동 재시도 중', 'warn'); }
      });
      run.statsTimer = setInterval(() => stats(run), 2000); socket.connect();
    } catch (e) { if (current(run)) { log(`시작 실패: ${e.message}`, 'error'); stop(e.message); status('시작 실패', e.message); } }
  }
  async function applyQuality() {
    const run = active; if (!run || !run.joined || run.role !== 'sender' || run.applying) return;
    run.applying = true; ui['btn-apply'].disabled = true;
    try {
      const q = settings();
      if (run.source === 'test') {
        const replacement = testPattern(q), oldStream = run.local, oldCleanup = run.captureCleanup;
        run.local = replacement.stream; run.captureCleanup = replacement.cleanup; run.quality = q;
        ui.mainVideo.srcObject = run.local;
        await Promise.all([...run.peers.values()].map(async peer => {
          const sender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
          try { if (sender) await sender.replaceTrack(run.local.getVideoTracks()[0]); }
          catch { if (peerCurrent(run, peer)) await startSender(run, peer.id); }
        }));
        oldCleanup?.(); oldStream.getTracks().forEach(t => t.stop());
        if (!current(run)) { replacement.cleanup(); replacement.stream.getTracks().forEach(t => t.stop()); return; }
        await play(run);
      } else {
        await run.local.getVideoTracks()[0].applyConstraints({ width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps } });
        if (!current(run)) return;
        run.quality = q;
      }
      const results = await Promise.allSettled([...run.peers.values()].map(peer => encodings(run, peer)));
      if (!current(run)) return;
      const failed = results.filter(result => result.status === 'rejected');
      actualFormat(run); log(`화질 적용 · 요청 ${q.width}×${q.height}, ${q.fps} FPS, 영상 상한 ${q.kbps} kbps/Viewer${failed.length ? ` · 인코더 ${failed.length}개 적용 실패` : ''}`, failed.length ? 'warn' : 'info');
    } catch (e) { if (current(run)) log(`화질 적용 실패: ${e.message}`, 'error'); }
    finally { run.applying = false; if (current(run)) ui['btn-apply'].disabled = !run.joined; }
  }
  async function copyLink(forObs) {
    const url = new URL(location.href); url.search = ''; url.hash = '';
    url.searchParams.set('role', 'viewer'); url.searchParams.set('room', active?.room || ui.roomName.value.trim() || 'studio'); url.searchParams.set('autojoin', '1');
    if (forObs) url.searchParams.set('obs', '1');
    if (relay) url.searchParams.set('relay', '1');
    const key = active?.key ?? ui.accessKey.value.trim(); if (key) url.hash = new URLSearchParams({ key }).toString();
    try { await navigator.clipboard.writeText(url.href); log(`${forObs ? 'OBS' : 'Viewer'} 링크를 복사했습니다.`); }
    catch { window.prompt('아래 링크를 복사하세요. 접속 키가 포함된 링크는 안전하게 공유하세요.', url.href); }
  }
  ui['btn-intercom'].addEventListener('click', toggleTalk);
  ui['btn-intercom-mute'].addEventListener('click', () => {
    if (!active?.talk.stream) return;
    const talk = active.talk; talk.muted = !talk.muted;
    talk.stream.getAudioTracks().forEach(t => { t.enabled = !talk.muted; }); talkUI(active);
  });
  ui['btn-intercom-play'].addEventListener('click', async () => {
    const run = active; if (!run) return;
    ui['btn-intercom-play'].hidden = true;
    await Promise.all([...run.talk.peers.values()].filter(p => p.audio).map(p => playTalk(run, p)));
  });
  ui.roleSelect.addEventListener('change', mode);
  ui['btn-join'].addEventListener('click', start);
  ui['btn-leave'].addEventListener('click', () => { log('사용자가 연결을 종료했습니다.'); stop(); });
  ui['btn-apply'].addEventListener('click', applyQuality);
  ui['btn-copy-viewer'].addEventListener('click', () => copyLink(false));
  ui['btn-copy-obs'].addEventListener('click', () => copyLink(true));
  ui['btn-clear-log'].addEventListener('click', () => ui.logs.replaceChildren());
  ui['btn-play'].addEventListener('click', () => { if (active) { active.muted = false; play(active); } });
  ui['btn-mute'].addEventListener('click', () => { if (active?.role === 'viewer') { active.muted = !ui.mainVideo.muted; ui.mainVideo.muted = active.muted; ui['btn-mute'].textContent = active.muted ? '소리 켜기' : '소리 끄기'; if (!active.muted) play(active); } });
  ui['btn-fullscreen'].addEventListener('click', () => ui.mainVideo.parentElement.requestFullscreen().catch(e => log(`전체 화면 실패: ${e.message}`, 'warn')));
  ui.mainVideo.addEventListener('playing', () => { if (active && ui.mainVideo.srcObject) waiting('', false); });
  window.addEventListener('pagehide', () => stop());
  mode(); lock(false);
  log('스튜디오 준비 완료 · Sender 1명, Viewer 최대 10명 (기본 설정)');
  if (obs || query.get('autojoin') === '1') start();
})();
