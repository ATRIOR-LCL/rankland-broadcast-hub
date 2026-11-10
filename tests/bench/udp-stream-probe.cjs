/* eslint-disable */
/**
 * 模拟推流的 UDP 恒定码率探测：按 RATE_MBPS 发送 1200 B 包，远端回显 8 B（序号 + 远端累计收包数），统计 RTT 与丢包。
 * 用于观察上传期间推流链路的排队时延（WebRTC 拥塞控制会因时延上升而降码率）。
 * 回程丢包（家用 NAT/下行常见）不影响推流，上行丢包按远端累计收包数计算。
 *
 * 远端回显（回包仅 8 B，不放大）：
 *   timeout 1800 python3 -c "import socket,struct;s=socket.socket(2,2);s.bind(('0.0.0.0',47998));n=0
 *   while 1: d,a=s.recvfrom(2048); n+=1; s.sendto(d[:4]+struct.pack('>I',n),a)"
 * 用法：
 *   TARGET=<server-ip>:47999 RATE_MBPS=10.3 DURATION_S=20 node tests/bench/udp-stream-probe.cjs
 */
const dgram = require('dgram');

const [HOST, PORT] = (process.env.TARGET || '').split(':');
if (!HOST || !PORT) {
  console.error('请设置 TARGET=<host>:<port>');
  process.exit(1);
}
const RATE_MBPS = Number(process.env.RATE_MBPS) || 10.3;
const DURATION_S = Number(process.env.DURATION_S) || 20;
const PACKET = 1200;

const socket = dgram.createSocket('udp4');
const sentAt = new Map();
const rtts = [];
let sent = 0;
let firstRecv = null;
let lastRecv = 0;

socket.on('message', (msg) => {
  const seq = msg.readUInt32BE(0);
  if (msg.length >= 8) {
    const n = msg.readUInt32BE(4);
    firstRecv = firstRecv === null ? n : Math.min(firstRecv, n);
    lastRecv = Math.max(lastRecv, n);
  }
  const t = sentAt.get(seq);
  if (t !== undefined) {
    rtts.push(Number(process.hrtime.bigint() - t) / 1e6);
    sentAt.delete(seq);
  }
});

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] : NaN;
};

const pps = (RATE_MBPS * 1e6) / 8 / PACKET;
const start = process.hrtime.bigint();
const buf = Buffer.alloc(PACKET);
const timer = setInterval(() => {
  const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
  if (elapsed >= DURATION_S) {
    clearInterval(timer);
    // 等待最后的回包
    setTimeout(() => {
      const lost = sent - rtts.length;
      console.log(
        JSON.stringify({
          rateMbps: RATE_MBPS,
          sent,
          lossPct: +((lost / sent) * 100).toFixed(2),
          upLossPct: firstRecv === null ? null : +((1 - (lastRecv - firstRecv + 1) / sent) * 100).toFixed(2),
          rttP50: +pct(rtts, 50).toFixed(1),
          rttP95: +pct(rtts, 95).toFixed(1),
          rttP99: +pct(rtts, 99).toFixed(1),
          rttMax: +Math.max(...rtts).toFixed(1),
        }),
      );
      socket.close();
    }, 2000);
    return;
  }
  for (const target = Math.floor(elapsed * pps); sent < target; sent++) {
    buf.writeUInt32BE(sent, 0);
    sentAt.set(sent, process.hrtime.bigint());
    socket.send(buf, Number(PORT), HOST);
  }
}, 1);
