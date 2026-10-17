#!/usr/bin/env python3
"""Check a real coturn UDP Allocate with time-limited REST credentials.
This checks authentication/allocation, not media relay end-to-end.
Use ACCESS_KEY in the environment if the HTTP endpoint is protected.
"""
import argparse
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import socket
import struct
import sys
import urllib.parse
import urllib.request

MAGIC = 0x2112A442

def attr(kind, value):
    return struct.pack('!HH', kind, len(value)) + value + b'\0' * (-len(value) % 4)

def header(kind, length, transaction):
    return struct.pack('!HHI', kind, length, MAGIC) + transaction

def attributes(body):
    result, offset = {}, 0
    while offset + 4 <= len(body):
        kind, length = struct.unpack_from('!HH', body, offset)
        offset += 4
        if offset + length > len(body):
            raise ValueError('Truncated STUN attribute')
        result[kind] = body[offset:offset + length]
        offset += length + (-length % 4)
    return result

def error_code(attrs):
    raw = attrs.get(0x0009)
    return (raw[2] & 7) * 100 + raw[3] if raw and len(raw) >= 4 else None

def request_packet(body, transaction, key=None):
    wire_header = header(0x0003, len(body) + (24 if key else 0), transaction)
    integrity = attr(0x0008, hmac.new(key, wire_header + body, hashlib.sha1).digest()) if key else b''
    return wire_header + body + integrity

def exchange(sock, packet, transaction):
    for _ in range(3):
        sock.send(packet)
        try:
            while True:
                reply = sock.recv(65535)
                if len(reply) < 20:
                    continue
                kind, length, magic = struct.unpack_from('!HHI', reply)
                if magic != MAGIC or reply[8:20] != transaction:
                    continue
                if len(reply) < 20 + length:
                    raise ValueError('Truncated STUN response')
                return kind, attributes(reply[20:20 + length])
        except socket.timeout:
            continue
    raise TimeoutError('No matching TURN response after 3 attempts; check address, UDP ports and container status')

def relay_address(raw, transaction):
    if not raw or len(raw) < 8:
        raise ValueError('Missing XOR-RELAYED-ADDRESS')
    port = struct.unpack_from('!H', raw, 2)[0] ^ (MAGIC >> 16)
    length = 4 if raw[1] == 1 else 16
    mask = struct.pack('!I', MAGIC) + transaction
    data = bytes(a ^ b for a, b in zip(raw[4:4 + length], mask))
    return f'{ipaddress.ip_address(data)}:{port}'

def check(url, host_override=None):
    headers = {'Authorization': 'Bearer ' + os.environ['ACCESS_KEY']} if os.environ.get('ACCESS_KEY') else {}
    req = urllib.request.Request(url.rstrip('/') + '/api/turn-credentials', headers=headers)
    with urllib.request.urlopen(req, timeout=10) as response:
        config = json.load(response)
    chosen = None
    for server in config.get('servers', []):
        urls = server.get('urls', [])
        for uri in [urls] if isinstance(urls, str) else urls:
            if uri.startswith('turn:') and not uri.startswith('turn://') and 'transport=udp' in uri:
                chosen = server, uri
                break
        if chosen:
            break
    if not chosen:
        raise ValueError('No valid UDP TURN URI in API response')
    server, uri = chosen
    parsed = urllib.parse.urlsplit('//' + uri[5:].split('?', 1)[0])
    host, port = host_override or parsed.hostname, parsed.port or 3478
    if host == 'localhost':
        host = '127.0.0.1'
    family, socktype, protocol, _, address = socket.getaddrinfo(host, port, type=socket.SOCK_DGRAM)[0]
    with socket.socket(family, socktype, protocol) as sock:
        sock.settimeout(2)
        sock.connect(address)
        base = attr(0x0019, b'\x11\0\0\0') + attr(0x000d, struct.pack('!I', 60))
        tx = secrets.token_bytes(12)
        kind, challenge = exchange(sock, request_packet(base, tx), tx)
        if kind != 0x0113 or error_code(challenge) != 401:
            raise ValueError(f'Expected 401 challenge, received type {kind:#06x}, error {error_code(challenge)}')
        print('[TURN] 401 challenge received (normal authentication handshake)')
        realm, nonce = challenge[0x0014], challenge[0x0015]
        username, password = server['username'].encode(), server['credential'].encode()
        key = hashlib.md5(username + b':' + realm + b':' + password).digest()
        def authenticated(lifetime, current_nonce):
            body = attr(0x0019, b'\x11\0\0\0') + attr(0x000d, struct.pack('!I', lifetime))
            return body + attr(0x0006, username) + attr(0x0014, realm) + attr(0x0015, current_nonce)
        for attempt in range(2):
            tx = secrets.token_bytes(12)
            kind, result = exchange(sock, request_packet(authenticated(60, nonce), tx, key), tx)
            if error_code(result) == 438 and attempt == 0:
                nonce = result[0x0015]
                continue
            break
        if kind != 0x0103:
            raise ValueError(f'Authenticated Allocate failed: {error_code(result)}. Check shared secret, timestamp and realm.')
        print('[TURN] SUCCESS: authenticated Allocate; relay=' + relay_address(result.get(0x0016), tx))
        # Release allocation: Refresh method 0x0004, success 0x0104.
        body = attr(0x000d, struct.pack('!I', 0)) + attr(0x0006, username) + attr(0x0014, realm) + attr(0x0015, nonce)
        tx = secrets.token_bytes(12)
        head = header(0x0004, len(body) + 24, tx)
        sock.send(head + body + attr(0x0008, hmac.new(key, head + body, hashlib.sha1).digest()))
        print('[TURN] Allocation release requested. Media relay still requires a browser test.')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://localhost:3000')
    parser.add_argument('--host', help='Override UDP target address for local diagnostics')
    args = parser.parse_args()
    try:
        check(args.url, args.host)
        return 0
    except Exception as error:
        print('[TURN] FAILED: ' + str(error), file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())
