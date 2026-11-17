#!/usr/bin/env python3
"""推流 mock 的 UDP 回显（跑在被测服务器上）。

每收到一个包回 12 字节：流 ID(2) + 序号(4) + 该流累计收包数(4) + 保留(2)。
累计收包数按 (来源地址, 流 ID) 统计，发送端每次运行换新端口即从 0 开始。

用法：nohup timeout 7200 python3 udp-echo.py 49990 > echo.log 2>&1 &
"""
import socket
import struct
import sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 49990
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 8 << 20)
sock.bind(('0.0.0.0', port))
print(f'udp echo listening on {port}', flush=True)

counts = {}
while True:
    data, addr = sock.recvfrom(2048)
    if len(data) < 6:
        continue
    sid, seq = struct.unpack_from('>HI', data)
    key = (addr, sid)
    n = counts.get(key, 0) + 1
    counts[key] = n
    sock.sendto(struct.pack('>HIIH', sid, seq, n & 0xFFFFFFFF, 0), addr)
