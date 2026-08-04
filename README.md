# WebRTC Low-Latency P2P

이 PC 한 대에서 다음 서비스를 함께 실행합니다.

- Caddy: `https://kbcwebrtctest.gleeze.com`의 `80/443`
- Node.js: Caddy가 `127.0.0.1:3000`으로 reverse proxy하는 signaling 서버
- Coturn Docker: `3478`, `5349`, UDP relay `49160-49200`
- Google STUN: 공인 주소 탐색만 담당하며 미디어를 중계하지 않음

현재 DNS와 Windows 네트워크 인터페이스는 모두 public IP `203.251.53.122`를 사용하므로 Coturn의 `external-ip`도 같은 주소를 사용합니다. Caddy와 Coturn은 포트가 달라 충돌하지 않습니다.

## 환경변수

루트의 `.env.example`을 `.env`로 만들고 아래 값을 설정합니다. Node.js 20.12 이상에서는 서버 시작 시 `.env`를 자동으로 읽습니다.

```env
TURN_DOMAIN=kbcwebrtctest.gleeze.com
TURN_REALM=kbcwebrtctest.gleeze.com
TURN_SHARED_SECRET=랜덤으로_생성한_비밀키
TURN_TTL_SECONDS=3600
```

`infra/coturn/.env.example`도 `infra/coturn/.env`로 만들고 반드시 같은 shared secret을 넣습니다.

```env
TURN_EXTERNAL_IP=203.251.53.122
TURN_REALM=kbcwebrtctest.gleeze.com
TURN_SHARED_SECRET=백엔드와_동일한_비밀키
```

`.env`, 인증서, 개인키는 Git에서 제외됩니다.

## Caddy 인증서 동기화

Caddy가 발급한 `kbcwebrtctest.gleeze.com` 인증서를 Coturn이 읽을 수 있도록 복사합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\coturn\sync-caddy-cert.ps1
```

복사된 파일은 무시된 `infra/coturn/certs/fullchain.pem`과 `privkey.pem`입니다. Caddy가 인증서를 갱신한 뒤에는 이 명령을 다시 실행하고 Coturn을 재시작합니다.

## Coturn 실행

Docker Desktop이 Linux containers 모드로 실행 중이어야 합니다.

```powershell
docker info --format 'OSType={{.OSType}} ServerVersion={{.ServerVersion}}'
docker compose --env-file infra/coturn/.env -f infra/coturn/compose.yaml config
docker compose --env-file infra/coturn/.env -f infra/coturn/compose.yaml up -d
docker compose --env-file infra/coturn/.env -f infra/coturn/compose.yaml logs -f
```

Compose는 Windows Docker Desktop에서 다음 포트를 명시적으로 publish합니다.

| 프로토콜 | 포트 | 용도 |
| --- | --- | --- |
| UDP | `3478` | TURN 기본 전송 |
| TCP | `3478` | UDP 차단 환경용 TURN |
| TCP | `5349` | TLS 기반 TURNS |
| UDP | `49160-49200` | 미디어 relay 범위 |

Windows Defender 방화벽은 관리자 PowerShell에서 설정합니다.

```powershell
New-NetFirewallRule -DisplayName "Coturn UDP 3478" -Direction Inbound -Protocol UDP -LocalPort 3478 -Action Allow
New-NetFirewallRule -DisplayName "Coturn TCP 3478" -Direction Inbound -Protocol TCP -LocalPort 3478 -Action Allow
New-NetFirewallRule -DisplayName "Coturn TLS TCP 5349" -Direction Inbound -Protocol TCP -LocalPort 5349 -Action Allow
New-NetFirewallRule -DisplayName "Coturn Relay UDP" -Direction Inbound -Protocol UDP -LocalPort 49160-49200 -Action Allow
```

이 PC가 public IP를 직접 보유하므로 공유기 포트 포워딩은 필요하지 않습니다. 상위 기관 방화벽 또는 통신사 방화벽이 있다면 동일 포트를 별도로 허용해야 합니다.

## 단기 TURN 자격 증명

인증된 관리자 또는 방 비밀번호 인증을 완료한 시청자만 다음 API를 호출할 수 있습니다.

```text
GET /api/rooms/:roomId/turn-credentials
```

백엔드는 만료 가능한 username과 HMAC-SHA1 credential을 발급합니다. 브라우저의 ICE 구성은 다음 URL을 사용합니다.

```text
stun:stun.l.google.com:19302
turn:kbcwebrtctest.gleeze.com:3478?transport=udp
turn:kbcwebrtctest.gleeze.com:3478?transport=tcp
turns:kbcwebrtctest.gleeze.com:5349?transport=tcp
```

브라우저 번들에는 shared secret이나 장기 TURN 비밀번호가 포함되지 않습니다. 운영 기본값은 `iceTransportPolicy: "all"`입니다.

## 검증

1. `docker compose ... logs`에서 Coturn의 listener와 TLS 오류가 없는지 확인합니다.
2. 송출자와 가능하면 다른 인터넷 회선의 시청자를 연결합니다.
3. `chrome://webrtc-internals` 또는 Trickle ICE에서 `host`, `srflx`, `relay` candidate를 확인합니다.
4. TURN 단독 검증 시 두 HTML의 `iceTransportPolicy`를 잠시 `"relay"`로 변경합니다.
5. 검증 후 반드시 `iceTransportPolicy: "all"`로 되돌립니다.

`relay` candidate가 없으면 Windows 방화벽, 상위 네트워크 방화벽, Caddy 인증서 동기화, shared secret 일치 여부를 순서대로 확인합니다.
