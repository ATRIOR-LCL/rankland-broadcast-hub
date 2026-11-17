/* eslint-disable */
/**
 * 推流 mock：按 WebRTC 视频的发包形态向 udp-echo.py 发 UDP 包，统计上行丢包、RTT、抖动与帧完整率。
 *
 * 一帧切成若干个 mtu 字节的包，默认同一帧的包同步突发发出（pacer 关闭时的最坏情况）；
 * pacingMs > 0 时把一帧的包摊到 pacingMs 毫秒内发出。
 * 包头：流 ID(2) + 序号(4) + 发送时间(8) + 帧号(4) + 是否关键帧(1)，其余为填充。
 *
 * 既可被 stress.cjs 引用，也可单独运行：
 *   node stream-mock.cjs echo=<echo-host>:49990 streams=2 mbps=10 dur=30
 */
const dgram = require('dgram');
const { performance } = require('perf_hooks');

const RING = 1 << 18;
/** 一帧发出后超过该时长仍有包没回显，就算作不完整（与 jitter buffer 的等待上限同量级） */
const FRAME_DEADLINE_MS = 1000;

/** 固定精度（默认 0.1 ms）的直方图，内存固定，适合长时间累计 RTT */
class Histogram {
  constructor(maxMs = 5000, res = 0.1) {
    this.res = res;
    this.bins = new Uint32Array(Math.ceil(maxMs / this.res) + 1);
    this.count = 0;
    this.max = 0;
    this.sum = 0;
  }

  add(ms) {
    const i = Math.min(this.bins.length - 1, Math.max(0, Math.round(ms / this.res)));
    this.bins[i]++;
    this.count++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  percentile(p) {
    if (!this.count) return null;
    const target = Math.ceil((p / 100) * this.count);
    let acc = 0;
    for (let i = 0; i < this.bins.length; i++) {
      acc += this.bins[i];
      if (acc >= target) return +(i * this.res).toFixed(1);
    }
    return this.max;
  }

  summary() {
    return {
      n: this.count,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      max: this.count ? +this.max.toFixed(1) : null,
      avg: this.count ? +(this.sum / this.count).toFixed(2) : null,
    };
  }
}

function newBucket() {
  return { sent: 0, sentBytes: 0, echoed: 0, lost: 0, frames: 0, framesOk: 0, keys: 0, keysOk: 0, sendErrors: 0, rtt: new Histogram(), driftMax: 0 };
}

function summarizeBucket(b) {
  const done = b.echoed + b.lost;
  return {
    sent: b.sent,
    mbps: null,
    lossPct: done ? +((b.lost / done) * 100).toFixed(3) : null,
    lost: b.lost,
    frames: b.frames,
    frameOkPct: b.frames ? +((b.framesOk / b.frames) * 100).toFixed(3) : null,
    keyFrames: b.keys,
    keyOkPct: b.keys ? +((b.keysOk / b.keys) * 100).toFixed(2) : null,
    rtt: b.rtt.summary(),
    driftMaxMs: +b.driftMax.toFixed(1),
    sendErrors: b.sendErrors,
  };
}

class Stream {
  constructor(sid, opts, owner) {
    this.sid = sid;
    this.opts = opts;
    this.owner = owner;
    this.seq = 0;
    this.frameNo = 0;
    this.sendTimes = new Float64Array(RING);
    this.seqs = new Uint32Array(RING);
    this.pktFrame = new Uint32Array(RING);
    this.frames = [];
    this.framesByNo = new Map();
    this.lastCount = 0;
    this.lastRtt = null;
    this.jitter = 0;
    const { mbps, fps, gopSec, keyRatio } = opts;
    const framesPerGop = Math.round(fps * gopSec);
    this.pSize = Math.round((mbps * 1e6 * gopSec) / 8 / (keyRatio + framesPerGop - 1));
    this.keySize = Math.round(this.pSize * keyRatio);
    this.framesPerGop = framesPerGop;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg) => this.onEcho(msg));
    this.sock.on('error', () => owner.cur.sendErrors++);
  }

  async start(delayMs) {
    await new Promise((r) => this.sock.bind(0, r));
    try {
      this.sock.setSendBufferSize(4 << 20);
      this.sock.setRecvBufferSize(4 << 20);
    } catch (e) {}
    const interval = 1000 / this.opts.fps;
    const t0 = performance.now() + delayMs;
    let i = 0;
    const tick = () => {
      if (this.stopped) return;
      const target = t0 + i * interval;
      const drift = performance.now() - target;
      if (drift > this.owner.cur.driftMax) this.owner.cur.driftMax = drift;
      if (drift > this.owner.phaseBucket.driftMax) this.owner.phaseBucket.driftMax = drift;
      this.sendFrame();
      i++;
      this.timer = setTimeout(tick, Math.max(0, t0 + i * interval - performance.now()));
    };
    this.timer = setTimeout(tick, delayMs);
  }

  sendFrame() {
    const key = this.frameNo % this.framesPerGop === 0;
    const size = key ? this.keySize : this.pSize;
    const mtu = this.opts.mtu;
    const n = Math.ceil(size / mtu);
    const frame = { no: this.frameNo, n, got: 0, key, at: performance.now(), bucket: this.owner.cur, phaseBucket: this.owner.phaseBucket };
    this.frames.push(frame);
    this.framesByNo.set(frame.no, frame);
    const sendOne = (len) => {
      const buf = Buffer.allocUnsafe(len);
      const seq = this.seq++ >>> 0;
      const now = performance.now();
      buf.writeUInt16BE(this.sid, 0);
      buf.writeUInt32BE(seq, 2);
      buf.writeDoubleBE(now, 6);
      buf.writeUInt32BE(frame.no >>> 0, 14);
      buf.writeUInt8(key ? 1 : 0, 18);
      const slot = seq & (RING - 1);
      this.sendTimes[slot] = now;
      this.seqs[slot] = seq;
      this.pktFrame[slot] = frame.no >>> 0;
      for (const b of [this.owner.cur, this.owner.phaseBucket]) {
        b.sent++;
        b.sentBytes += len;
      }
      this.owner.totalSent++;
      this.sock.send(buf, this.opts.port, this.opts.host, (err) => {
        if (err) this.owner.cur.sendErrors++;
      });
    };
    const lens = [];
    for (let left = size; left > 0; left -= mtu) lens.push(Math.min(mtu, left));
    const pacingMs = this.opts.pacingMs;
    if (!pacingMs || lens.length === 1) {
      lens.forEach(sendOne);
    } else {
      const groups = Math.min(pacingMs, lens.length);
      const per = Math.ceil(lens.length / groups);
      for (let g = 0; g < groups; g++) {
        const part = lens.slice(g * per, (g + 1) * per);
        if (g === 0) part.forEach(sendOne);
        else setTimeout(() => part.forEach(sendOne), g);
      }
    }
    this.frameNo++;
  }

  onEcho(msg) {
    if (msg.length < 10) return;
    const seq = msg.readUInt32BE(2);
    const count = msg.readUInt32BE(6);
    if (count > this.lastCount) this.lastCount = count;
    const slot = seq & (RING - 1);
    if (this.seqs[slot] !== seq || !this.sendTimes[slot]) return;
    const rtt = performance.now() - this.sendTimes[slot];
    this.sendTimes[slot] = 0;
    const frame = this.framesByNo.get(this.pktFrame[slot]);
    if (frame) {
      frame.got++;
      for (const b of [frame.bucket, frame.phaseBucket]) {
        b.rtt.add(rtt);
        b.echoed++;
      }
    }
    if (this.lastRtt !== null) this.jitter += (Math.abs(rtt - this.lastRtt) - this.jitter) / 16;
    this.lastRtt = rtt;
  }

  /** 把超过 FRAME_DEADLINE_MS 的帧结算到发出时所在的统计桶；force 时全部结算 */
  sweep(force) {
    const now = performance.now();
    while (this.frames.length && (force || now - this.frames[0].at > FRAME_DEADLINE_MS)) {
      const f = this.frames.shift();
      this.framesByNo.delete(f.no);
      const ok = f.got >= f.n;
      // 每秒桶与阶段桶都按帧发出的时刻归属
      for (const b of [f.bucket, f.phaseBucket]) {
        b.frames++;
        if (ok) b.framesOk++;
        if (f.key) {
          b.keys++;
          if (ok) b.keysOk++;
        }
        b.lost += f.n - Math.min(f.got, f.n);
      }
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

/**
 * @param {object} o host, port, streams, mbps, fps, gopSec, keyRatio, mtu, pacingMs
 */
function createStreams(o) {
  const opts = {
    host: o.host,
    port: o.port || 49990,
    mbps: o.mbps || 10,
    fps: o.fps || 30,
    gopSec: o.gopSec || 2,
    keyRatio: o.keyRatio || 8,
    mtu: o.mtu || 1200,
    pacingMs: o.pacingMs || 0,
  };
  const owner = {
    cur: newBucket(),
    phaseBucket: newBucket(),
    phases: {},
    totalSent: 0,
  };
  const sidBase = Math.floor(Math.random() * 60000);
  const list = [];
  for (let i = 0; i < (o.streams || 0); i++) {
    const s = new Stream((sidBase + i) & 0xffff, opts, owner);
    // 各路编码器相互独立，关键帧相位错开（否则所有流的关键帧同时突发）
    s.frameNo = Math.round((i * s.framesPerGop) / o.streams);
    list.push(s);
  }
  const sweeper = setInterval(() => list.forEach((s) => s.sweep(false)), 100);
  let pendingSeconds = [];

  return {
    opts,
    count: list.length,
    async start() {
      const interval = 1000 / opts.fps;
      await Promise.all(list.map((s, i) => s.start(Math.random() * interval)));
    },
    setPhase(name) {
      owner.phaseBucket = newBucket();
      owner.phases[name] = owner.phaseBucket;
    },
    /**
     * 每秒调用一次：开启新的每秒桶，返回 FRAME_DEADLINE_MS 之前那一秒（帧已全部结算）的统计。
     */
    rotate() {
      if (!list.length) return null;
      const finished = owner.cur;
      finished.endedAt = performance.now();
      pendingSeconds.push(finished);
      owner.cur = newBucket();
      const out = [];
      while (pendingSeconds.length && performance.now() - pendingSeconds[0].endedAt > FRAME_DEADLINE_MS + 100) {
        const b = pendingSeconds.shift();
        const s = summarizeBucket(b);
        s.mbps = +((b.sentBytes * 8) / 1e6).toFixed(2);
        s.jitterMs = +(list.reduce((a, x) => a + x.jitter, 0) / list.length).toFixed(2);
        out.push(s);
      }
      return out;
    },
    async stop() {
      list.forEach((s) => s.stop());
      await new Promise((r) => setTimeout(r, FRAME_DEADLINE_MS + 200));
      clearInterval(sweeper);
      list.forEach((s) => s.sweep(true));
      const lastCount = list.reduce((a, s) => a + s.lastCount, 0);
      list.forEach((s) => s.sock.close());
      const phases = {};
      for (const [name, b] of Object.entries(owner.phases)) phases[name] = summarizeBucket(b);
      return {
        streams: list.length,
        mbpsPerStream: opts.mbps,
        pSize: list[0]?.pSize,
        keySize: list[0]?.keySize,
        totalSent: owner.totalSent,
        // 以回显端累计收包数为准的上行丢包（不受回程丢包影响）
        upLossPct: owner.totalSent ? +(((owner.totalSent - lastCount) / owner.totalSent) * 100).toFixed(3) : null,
        phases,
      };
    },
  };
}

module.exports = { createStreams, Histogram };

if (require.main === module) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
  if (!args.echo) {
    console.error('usage: node stream-mock.cjs echo=<host>:<port> [streams=1] [mbps=10] [dur=10]');
    process.exit(2);
  }
  const [host, port] = args.echo.split(':');
  const s = createStreams({
    host,
    port: +port,
    streams: +(args.streams || 1),
    mbps: +(args.mbps || 10),
    pacingMs: +(args.pacingMs || 0),
  });
  const dur = +(args.dur || 10);
  (async () => {
    s.setPhase('run');
    await s.start();
    const t = setInterval(() => (s.rotate() || []).forEach((x) => console.log(JSON.stringify({ ts: Date.now(), ...x }))), 1000);
    await new Promise((r) => setTimeout(r, dur * 1000));
    clearInterval(t);
    console.log(JSON.stringify({ type: 'summary', ...(await s.stop()) }));
  })();
}
