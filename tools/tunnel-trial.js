'use strict';
// Opt-in free HTTPS trial. Keeps local/public credentials and services separate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const dotenv = require('dotenv');
const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env.tunnel');
const accessPath = path.join(root, 'TUNNEL-ACCESS.private.html');
const composeArgs = ['compose', '--env-file', '.env.tunnel', '-p', 'webrtc-tunnel', '-f', 'docker-compose.tunnel.yml'];
function compose(args, capture = false) {
  return execFileSync('docker', [...composeArgs, ...args], {
    cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 180000, windowsHide: true
  });
}
function readEnv() { return dotenv.parse(fs.readFileSync(envPath)); }
function getUrl() {
  const logs = compose(['logs', '--no-color', '--tail', '200', 'tunnel'], true);
  return [...logs.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/g)].at(-1)?.[0];
}
function accessHtml(url, key) {
  const link = query => `${url}/?${query}#key=${encodeURIComponent(key)}`;
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>WebRTC 임시 접속 링크 — 비공개</title>
<style>body{font:17px/1.7 system-ui;max-width:780px;margin:60px auto;padding:24px;background:#f5f7fa;color:#182336}a{display:block;padding:16px;margin:12px 0;background:white;border-radius:12px;color:#1552b5}code{overflow-wrap:anywhere}</style>
<h1>WebRTC 임시 접속</h1><p>이 파일의 링크에는 비공개 접속 키가 들어 있습니다. 신뢰하는 시청자에게만 링크를 공유하세요.</p>
<a href="${link('role=sender&room=studio')}">Sender 열기</a>
<a href="${link('role=viewer&room=studio&autojoin=1')}">Viewer 열기 / 링크 주소 복사</a>
<a href="${link('obs=1&room=studio')}">OBS 영상 전용 / 링크 주소 복사</a>
<p>웹 주소: <code>${url}</code></p><p>외부 TURN 없이 직접 연결을 시험합니다. 네트워크에 따라 영상이 연결되지 않을 수 있습니다. kbctest.kro.kr의 정식 배포 주소는 아닙니다.</p>
<p>종료: <code>node tools/tunnel-trial.js stop</code><br>재실행: <code>node tools/tunnel-trial.js start</code><br>PC·Docker·터널이 실행 중일 때만 접속할 수 있습니다. 터널 재생성 후에는 이 파일의 새 링크를 사용하세요.</p></html>`;
}
async function main() {
  const action = process.argv[2] || 'status';
  if (!['start', 'status', 'stop'].includes(action)) throw new Error('Usage: node tools/tunnel-trial.js start|status|stop');
  if (action === 'stop') {
    if (!fs.existsSync(envPath)) return console.log('Trial has not been configured.');
    compose(['down']);
    if (fs.existsSync(accessPath)) fs.writeFileSync(accessPath, '<!doctype html><meta charset="utf-8"><h1>임시 터널 종료됨</h1><p>node tools/tunnel-trial.js start 로 다시 시작하세요.</p>');
    return console.log('Trial stopped. Local/public settings preserved.');
  }
  if (action === 'status') {
    if (!fs.existsSync(envPath)) return console.log('Trial has not been configured.');
    compose(['ps']);
    const url = getUrl();
    console.log(url ? `Trial URL (no key): ${url}` : 'No trial URL found.');
    return;
  }
  if (!fs.existsSync(envPath)) fs.writeFileSync(envPath,
    `ACCESS_KEY=${crypto.randomBytes(32).toString('hex')}\nCORS_ORIGIN=http://localhost:3001\nMAX_VIEWERS=10\n`, { mode: 0o600 });
  const env = readEnv();
  if (!/^[a-f0-9]{64}$/i.test(env.ACCESS_KEY || '')) throw new Error('.env.tunnel ACCESS_KEY must be a random 32-byte hexadecimal value.');
  compose(['config', '--quiet']);
  compose(['up', '-d', '--build']);
  let url;
  for (let attempt = 0; attempt < 30; attempt++) {
    url = getUrl();
    if (url) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!url) throw new Error('No tunnel URL received. Check Docker tunnel logs/network; the trial can be stopped with this script.');
  const contents = fs.readFileSync(envPath, 'utf8');
  const newContents = /^CORS_ORIGIN=.*$/m.test(contents)
    ? contents.replace(/^CORS_ORIGIN=.*$/m, `CORS_ORIGIN=${url}`)
    : `${contents}\nCORS_ORIGIN=${url}\n`;
  fs.writeFileSync(envPath, newContents, { mode: 0o600 });
  // Recreate only the origin; retaining the tunnel keeps its assigned hostname.
  compose(['up', '-d', '--no-deps', 'signaling']);
  let ready = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(`${url}/api/turn-credentials`, {
        headers: { Authorization: `Bearer ${env.ACCESS_KEY}` }, signal: AbortSignal.timeout(5000)
      });
      const ice = await response.json();
      if (response.ok && ice.turnConfigured === false && Array.isArray(ice.servers)) { ready = true; break; }
    } catch { /* Origin recreation and edge propagation can take a few seconds. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('HTTPS trial did not become ready. Check trial logs; local configuration is unchanged.');
  fs.writeFileSync(accessPath, accessHtml(url, env.ACCESS_KEY), { mode: 0o600 });
  console.log(`Trial URL (no key): ${url}`);
  console.log(`Private Sender/Viewer/OBS links: ${accessPath}`);
  console.log('STUN only: cross-network media is not guaranteed. Keep PC, Docker and tunnel running.');
}
main().catch(error => {
  console.error(error.status !== undefined ? `Docker command failed (exit ${error.status}). Check Docker Desktop and trial logs.` : error.message);
  process.exitCode = 1;
});
