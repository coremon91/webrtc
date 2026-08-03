# WebRTC Low-Latency P2P

이 프로젝트는 Google STUN으로 공인 주소를 탐색하고, 직접 P2P 연결이 불가능할 때 자체 Coturn 서버로 미디어를 relay합니다. Google STUN은 미디어를 중계하지 않습니다.

## 애플리케이션 실행

Node.js 18 이상에서 의존성을 설치하고 환경변수를 설정한 뒤 실행합니다.

```bash
npm install
npm start
```

백엔드에 필요한 TURN 환경변수는 다음과 같습니다.

| 변수 | 예시 | 설명 |
| --- | --- | --- |
| `TURN_DOMAIN` | `turn.example.com` | 브라우저가 접속할 TURN 도메인 |
| `TURN_REALM` | `turn.example.com` | Coturn realm. Coturn 설정과 동일하게 유지 |
| `TURN_SHARED_SECRET` | secret manager 값 | Coturn과 백엔드가 공유하는 비밀키 |
| `TURN_TTL_SECONDS` | `3600` | 단기 자격 증명 유효시간. 60-86400초로 제한 |

`TURN_SHARED_SECRET`은 `openssl rand -hex 32` 등으로 생성하고 저장소에 커밋하지 않습니다. 백엔드와 Coturn에 반드시 같은 값을 환경변수 또는 secret manager로 주입합니다.

## Coturn 자체 서버 배포

Coturn은 Linux 서버에서 Docker host network로 실행합니다. [infra/coturn/.env.example](infra/coturn/.env.example)을 `infra/coturn/.env`로 복사한 다음 실제 값으로 바꿉니다. `.env`와 인증서/개인키는 Git에서 제외됩니다.

```bash
docker compose --env-file infra/coturn/.env -f infra/coturn/compose.yaml up -d
docker compose --env-file infra/coturn/.env -f infra/coturn/compose.yaml logs -f
```

`turn.example.com`의 A 레코드는 TURN 서버의 고정 public IP를 가리켜야 합니다. `turns:` 연결을 위해 해당 도메인의 유효한 TLS 인증서와 전체 체인(`fullchain.pem`), 개인키(`privkey.pem`)를 서버에 배치합니다. Let's Encrypt를 사용한다면 인증서 갱신 후 `docker compose ... restart coturn`으로 Coturn이 새 인증서를 읽게 합니다.

서버가 공유기/NAT 뒤에 있으면 `TURN_EXTERNAL_IP=PUBLIC_IP/PRIVATE_IP`로 설정합니다. 서버가 public IP를 인터페이스에 직접 가진 경우에는 `TURN_EXTERNAL_IP=PUBLIC_IP`만 사용합니다. NAT 장비는 relay 포트를 동일한 외부 포트로 전달하는 port-preserving 매핑이어야 합니다.

## 방화벽과 포트 포워딩

호스트 방화벽, 공유기 포트 포워딩, 클라우드 보안 그룹에 다음 inbound 규칙을 적용합니다.

| 프로토콜 | 포트 | 용도 |
| --- | --- | --- |
| UDP | `3478` | TURN/STUN 기본 전송 |
| TCP | `3478` | UDP 차단 환경용 TURN |
| TCP | `5349` | TLS 기반 TURNS |
| UDP | `49160-49200` | 제한된 미디어 relay 범위 |

Ubuntu UFW 예시는 다음과 같습니다.

```bash
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49200/udp
```

Docker Compose는 `network_mode: host`를 사용하므로 Linux 호스트에서 위 포트를 직접 수신합니다. 같은 서버에서 다른 서비스가 해당 포트를 사용하고 있지 않은지 확인합니다.

## 단기 TURN 자격 증명

인증된 관리자 또는 방 비밀번호 인증을 완료한 시청자만 다음 API를 호출할 수 있습니다.

```text
GET /api/rooms/:roomId/turn-credentials
```

백엔드는 만료 시각이 포함된 username과 `HMAC-SHA1(TURN_SHARED_SECRET, username)` credential을 발급합니다. 응답은 Google STUN과 아래 자체 TURN URL을 포함하며 `Cache-Control: no-store`로 반환됩니다.

```text
stun:stun.l.google.com:19302
turn:turn.example.com:3478?transport=udp
turn:turn.example.com:3478?transport=tcp
turns:turn.example.com:5349?transport=tcp
```

브라우저 HTML에는 장기 TURN 계정이나 shared secret이 포함되지 않습니다. 송출자와 시청자는 `RTCPeerConnection` 생성 전에 API에서 단기 자격 증명을 가져오며 운영 기본값은 `iceTransportPolicy: "all"`입니다.

## 운영 및 검증 절차

1. DNS A 레코드와 public IP가 일치하는지 확인합니다.
2. TLS 인증서의 SAN에 TURN 도메인이 포함되고 만료되지 않았는지 확인합니다.
3. Coturn과 Node 백엔드에 같은 `TURN_SHARED_SECRET`을 주입하고 두 서비스를 재시작합니다.
4. 방을 만든 뒤 송출자와 다른 네트워크의 시청자를 연결합니다.
5. Chrome의 `chrome://webrtc-internals` 또는 Trickle ICE에서 `host`, `srflx`, `relay` candidate가 모두 수집되는지 확인합니다.
6. TURN 단독 검증 시 두 HTML의 `iceTransportPolicy`를 일시적으로 `"relay"`로 바꾸고 미디어가 연결되는지 확인합니다.
7. 검증이 끝나면 반드시 `iceTransportPolicy: "all"`로 되돌립니다.

`relay` candidate가 없으면 먼저 DNS, 인증서, shared secret 일치 여부, public/private IP 매핑, UDP relay 포트 범위를 순서대로 확인합니다. 실제 미디어가 TURN을 통과하는 동안 서버 대역폭은 송수신 트래픽을 모두 부담하므로 네트워크 사용량과 Coturn 로그를 함께 모니터링합니다.
