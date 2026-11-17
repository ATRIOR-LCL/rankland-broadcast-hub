/* eslint-disable */
/**
 * 精彩回放上传 + 推流联合压测：选手 mock（socket.io /broadcaster）+ 上传 mock（与 KtB 协议一致、策略可配）
 * + 推流 mock（stream-mock.cjs）+ 导播端建任务，按「推流基线 → 上传 → 推流收尾」跑一个用例，输出 JSONL。
 *
 * 用法（参数均为 key=value）：
 *   node stress.cjs hub=https://<hub-host>:49992 token=<AUTH_TOKEN> streams=2 mbps=10 players=1 \
 *     media=media/clip-60s-10M.webm chunk=1M limit=k1.5 cap=45 pacing=smooth tc=45,0,1000 out=outputs/stress/B3/1.jsonl
 *
 * 主要参数：
 *   hub        测试 Hub 地址（必填）
 *   echo       udp-echo.py 地址，默认 <hub 主机>:49990
 *   mode       upload（默认）| none（只推流，跑 dur 秒）| head（建上传会话后每秒 HEAD，跑 dur 秒）
 *   chunk      分块大小，支持 256K / 1M / 4M
 *   limit      none | <Mbps> | k<系数>（= cap − 系数 × 推流总码率，下限 limitMin）
 *   pacing     none | gap（整块发出，块间等待）| smooth（请求体内按 16 KiB 匀速写出）
 *   concurrency 每名选手同时处理的任务项数；items 为每名选手的任务数
 *   tc         C,D,Q：对 tcDst 整形（Mbps, 单程附加时延 ms, 队列包数）；tcClear=1 结束后删除规则
 *   outage     at,dur：上传开始 at 秒后对 tcDst 断网 dur 秒（需同时有 tc）
 *   socketDrop at,dur：上传开始 at 秒后断开所有选手 socket，dur 秒后重连并 confirmReady
 *   progress   1（默认）：与 KtB 一样每块后上报一次 uploading 进度
 *   retry5xx   1：5xx 也退避重试（KtB 现状为 0，直接失败）
 *   tcCmd      默认 "sudo -n tc"；bench 跑在容器里时用 "nsenter -t 1 -m -n tc"
 *
 * 注意：tc 加在 bench 所在主机的出口上时，Linux 的 TCP Small Queues 会把本机 TCP 在 qdisc 里的排队量压到约 1 ms，
 * 模拟不出路由器的 bufferbloat。因此 bench 放在 docker bridge 容器里跑（包经 veth 转发后不再受 TSQ 约束），
 * tc 仍加在宿主机 eth0 上，相当于一台独立的路由器。见 README。
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { performance } = require('perf_hooks');
const { createStreams, Histogram } = require('./stream-mock.cjs');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=');
    return [a.slice(0, i), a.slice(i + 1)];
  }),
);
const num = (k, d) => (args[k] === undefined ? d : +args[k]);
const sizeArg = (v) => {
  const m = /^(\d+(?:\.\d+)?)([KM]?)$/i.exec(v);
  return Math.round(+m[1] * { '': 1, K: 1024, M: 1024 * 1024 }[m[2].toUpperCase()]);
};

if (!args.hub) {
  console.error('usage: node stress.cjs hub=https://<hub-host>:49992 token=<AUTH_TOKEN> [key=value ...]');
  process.exit(2);
}
const HUB = new URL(args.hub);
const TOKEN = args.token || process.env.AUTH_TOKEN;
const UCA = args.uca || `stress-${Date.now().toString(36)}`;
const MODE = args.mode || 'upload';
const [ECHO_HOST, ECHO_PORT] = (args.echo || `${HUB.hostname}:49990`).split(':');
const STREAMS = num('streams', 0);
const STREAM_MBPS = num('mbps', 10);
const PLAYERS = num('players', 1);
const FIRST_USER = num('firstUser', 1);
const ITEMS = num('items', 1);
const CONCURRENCY = num('concurrency', 1);
const MEDIA = args.media || path.join(__dirname, 'media/clip-60s-10M.webm');
const THUMB = args.thumb || path.join(path.dirname(MEDIA), 'thumb.jpg');
const DUR_MS = num('durMs', +((/(\d+)s-/.exec(path.basename(MEDIA)) || [])[1] || 60) * 1000);
const CHUNK = sizeArg(args.chunk || '1M');
const PACING = args.pacing || 'none';
const CAP = num('cap', 45);
const LIMIT_MIN = num('limitMin', 2);
const PROCESSING_MS = num('processingMs', 2000);
const PROGRESS = num('progress', 1);
const PRE = num('pre', 10);
const POST = num('post', 10);
const DUR = num('dur', 30);
const UPLOAD_TIMEOUT = num('uploadTimeout', 900);
const DEV = args.dev || 'eth0';
const TC_DST = args.tcDst || ECHO_HOST;
const OUT = args.out || path.join(__dirname, `outputs/stress/adhoc/${Date.now()}.jsonl`);
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 6;
const RETRY_5XX = num('retry5xx', 0);

const streamMbpsTotal = STREAMS * STREAM_MBPS;
const LIMIT_MBPS = (() => {
  const v = args.limit || 'none';
  if (v === 'none') return 0;
  if (v.startsWith('k')) return Math.max(LIMIT_MIN, CAP - +v.slice(1) * streamMbpsTotal);
  return +v;
})();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.createWriteStream(OUT);
const T0 = performance.now();
const now = () => +(performance.now() - T0).toFixed(1);
const write = (obj) => out.write(JSON.stringify({ t: now(), ...obj }) + '\n');
const log = (...a) => console.log(`[${(now() / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// tc
// ---------------------------------------------------------------------------

// 在容器里跑时用 tcCmd="nsenter -t 1 -m -n tc" 操作宿主机的 qdisc
const TC_CMD = (args.tcCmd || 'sudo -n tc').split(' ');
function tc(...a) {
  return execFileSync(TC_CMD[0], [...TC_CMD.slice(1), ...a], { encoding: 'utf8' });
}

let tcParams = null;
/** netem 的 limit 把延迟线里的包也算在内：加上 C×D 对应的在途包数（按 1200 字节计），Q 才是真正的排队长度 */
const netemLimit = (C, D, Q) => Q + Math.ceil((C * 125 * D) / 1200);
function tcApply([C, D, Q]) {
  try {
    tc('qdisc', 'del', 'dev', DEV, 'root');
  } catch (e) {}
  tc('qdisc', 'add', 'dev', DEV, 'root', 'handle', '1:', 'htb', 'default', '10');
  tc('class', 'add', 'dev', DEV, 'parent', '1:', 'classid', '1:10', 'htb', 'rate', '10gbit');
  tc('class', 'add', 'dev', DEV, 'parent', '1:', 'classid', '1:20', 'htb', 'rate', `${C}mbit`, 'ceil', `${C}mbit`);
  tc('qdisc', 'add', 'dev', DEV, 'parent', '1:20', 'handle', '20:', 'netem', 'delay', `${D}ms`, 'limit', `${netemLimit(C, D, Q)}`);
  tc('filter', 'add', 'dev', DEV, 'parent', '1:', 'protocol', 'ip', 'u32', 'match', 'ip', 'dst', `${TC_DST}/32`, 'flowid', '1:20');
  tcParams = { C, D, Q };
}

function tcLoss(on) {
  const { D, Q } = tcParams;
  tc('qdisc', 'change', 'dev', DEV, 'parent', '1:20', 'handle', '20:', 'netem', 'delay', `${D}ms`, 'limit', `${netemLimit(tcParams.C, D, Q)}`, ...(on ? ['loss', '100%'] : []));
}

function parseTc(classText, qdiscText) {
  const cls = /class htb 1:20[\s\S]*?Sent (\d+) bytes (\d+) pkt \(dropped (\d+), overlimits (\d+)/.exec(classText);
  const nq = /qdisc netem 20:[\s\S]*?Sent (\d+) bytes (\d+) pkt \(dropped (\d+), overlimits (\d+)/.exec(qdiscText);
  return {
    bytes: cls ? +cls[1] : null,
    pkts: cls ? +cls[2] : null,
    classDrops: cls ? +cls[3] : null,
    overlimits: cls ? +cls[4] : null,
    netemDrops: nq ? +nq[3] : null,
  };
}

function tcStatsSync() {
  if (!tcParams) return null;
  return parseTc(tc('-s', 'class', 'show', 'dev', DEV), tc('-s', 'qdisc', 'show', 'dev', DEV));
}

function tcStatsAsync() {
  if (!tcParams) return Promise.resolve(null);
  const run = (a) => new Promise((r) => execFile(TC_CMD[0], [...TC_CMD.slice(1), ...a], { encoding: 'utf8' }, (e, so) => r(so || '')));
  return Promise.all([run(['-s', 'class', 'show', 'dev', DEV]), run(['-s', 'qdisc', 'show', 'dev', DEV])]).then(([c, q]) => parseTc(c, q));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const isHttps = HUB.protocol === 'https:';
const transport = isHttps ? https : http;
const newAgent = () => new transport.Agent({ keepAlive: true, rejectUnauthorized: false });
const directorAgent = newAgent();

/**
 * 发一个请求。body 为 Buffer，或为 async (req) => {} 自行写出请求体（需同时给 contentLength）。
 * 与 KtB 一致，整个请求（含响应）30 s 未完成即中止。
 */
function request(agent, method, urlPath, { headers = {}, json, body, contentLength } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let payload = body;
    if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json));
      h['Content-Type'] = 'application/json';
    }
    if (Buffer.isBuffer(payload)) h['Content-Length'] = payload.length;
    else if (typeof payload === 'function') h['Content-Length'] = contentLength;
    const req = transport.request(
      { protocol: HUB.protocol, hostname: HUB.hostname, port: HUB.port, path: urlPath, method, headers: h, agent },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          let data;
          try {
            data = JSON.parse(buf.toString());
          } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, json: data, text: buf.toString().slice(0, 200) });
        });
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('request timeout')), REQUEST_TIMEOUT_MS);
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    if (typeof payload === 'function') {
      payload(req).then(
        () => req.end(),
        (e) => req.destroy(e),
      );
    } else {
      req.end(payload);
    }
  });
}

async function api(agent, method, urlPath, opts) {
  const res = await request(agent, method, urlPath, opts);
  if (!res.json || !res.json.success) {
    const err = new Error(`${method} ${urlPath.split('?')[0]}: HTTP ${res.status} ${res.json ? res.json.msg || res.json.code : res.text}`);
    err.status = res.status;
    throw err;
  }
  return res.json.data;
}

const director = { 'X-UCA': UCA, 'X-Token': TOKEN };

// ---------------------------------------------------------------------------
// 限速
// ---------------------------------------------------------------------------

/** 令牌桶，允许欠账：取走后余额为负就睡到补齐，多个上传共用时总速率不超过 rate */
class Bucket {
  constructor(mbps, capBytes) {
    this.rate = (mbps * 1e6) / 8 / 1000; // bytes per ms
    this.cap = capBytes;
    this.tokens = capBytes;
    this.last = performance.now();
  }

  async take(n) {
    const t = performance.now();
    this.tokens = Math.min(this.cap, this.tokens + (t - this.last) * this.rate);
    this.last = t;
    this.tokens -= n;
    if (this.tokens < 0) await sleep(-this.tokens / this.rate);
  }
}

const SLICE = 16 * 1024;

// ---------------------------------------------------------------------------
// 媒体
// ---------------------------------------------------------------------------

function fileInfo(file, mimeType) {
  const size = fs.statSync(file).size;
  const cache = `${file}.sha256`;
  let checksum;
  if (fs.existsSync(cache) && fs.statSync(cache).mtimeMs >= fs.statSync(file).mtimeMs) {
    checksum = fs.readFileSync(cache, 'utf8').trim();
  } else {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    fs.closeSync(fd);
    checksum = hash.digest('hex');
    fs.writeFileSync(cache, checksum);
  }
  return { file, size, checksum, mimeType, name: path.basename(file) };
}

// ---------------------------------------------------------------------------
// 选手 mock
// ---------------------------------------------------------------------------

const results = [];
const counters = { ackedBytes: 0, chunks: 0, c409: 0, retries: 0, errors: 0, heads: 0 };
const chunkHist = new Histogram(60000, 1);

class Player {
  constructor(userId) {
    this.userId = userId;
    this.agent = newAgent();
    this.generations = new Map();
    this.running = 0;
    this.waiting = [];
    this.bucket = LIMIT_MBPS ? new Bucket(LIMIT_MBPS, PACING === 'gap' ? CHUNK : 4 * SLICE) : null;
    this.requests = 0;
  }

  connect() {
    const { io } = require('socket.io-client');
    this.socket = io(`${HUB.origin}/broadcaster`, {
      query: { uca: UCA, userId: this.userId },
      auth: { id: crypto.randomUUID(), broadcasterToken: `bt-${this.userId}` },
      transports: ['websocket'],
      rejectUnauthorized: false,
      reconnection: false,
    });
    this.socket.on('requestCreateClip', (payload, ack) => this.onRequest(payload, ack));
    return this.ready();
  }

  ready() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.userId} connect timeout`)), 20000);
      const onConnect = () =>
        this.socket.emit('confirmReady', { tracks: [{ trackId: 'screen', type: 'screen' }, { trackId: 'camera', type: 'camera' }] }, (res) => {
          clearTimeout(t);
          if (res && res.success === false) return reject(new Error(`confirmReady: ${JSON.stringify(res)}`));
          resolve();
        });
      if (this.socket.connected) onConnect();
      else {
        this.socket.once('connect', onConnect);
        this.socket.once('connect_error', (e) => {
          clearTimeout(t);
          reject(e);
        });
      }
    });
  }

  async reconnect() {
    this.socket.connect();
    await this.ready();
  }

  onRequest(payload, ack) {
    this.requests++;
    write({ type: 'event', ev: 'requestCreateClip', user: this.userId, taskId: payload.taskId, items: payload.items.map((i) => i.itemId) });
    if (!payload.preferred || !payload.preferred.containers.includes('webm')) {
      ack({ accepted: false, errorCode: 'unsupported_media' });
      return;
    }
    ack({ accepted: true });
    if (MODE === 'head') {
      const item = payload.items[0];
      api(this.agent, 'POST', `/api/clips/tasks/${payload.taskId}/uploads`, {
        headers: this.headers(item),
        json: { itemId: item.itemId, trackId: item.trackId, role: 'media', fileName: MEDIA_INFO.name, mimeType: MEDIA_INFO.mimeType, uploadLength: MEDIA_INFO.size, checksumSha256: MEDIA_INFO.checksum },
      }).then(
        (created) => (this.headSession = { url: created.uploadUrl || `/api/clips/uploads/${created.uploadId}`, headers: this.headers(item) }),
        (e) => log(`${this.userId} head session failed: ${e.message}`),
      );
      return;
    }
    for (const it of payload.items) {
      const item = { ...it, generation: (this.generations.get(it.itemId) || 0) + 1 };
      this.generations.set(it.itemId, item.generation);
      this.enqueue(() => this.processItem(payload, item));
    }
  }

  enqueue(fn) {
    const run = async () => {
      this.running++;
      try {
        await fn();
      } finally {
        this.running--;
        const next = this.waiting.shift();
        if (next) next();
      }
    };
    if (this.running < CONCURRENCY) run();
    else this.waiting.push(run);
  }

  headers(item) {
    return { 'X-UCA': UCA, 'X-Upload-Token': item.uploadToken };
  }

  async report(data, item, status, progress, errorCode, errorMessage) {
    try {
      await api(this.agent, 'POST', `/api/clips/tasks/${data.taskId}/progress`, {
        headers: this.headers(item),
        json: { itemId: item.itemId, status, progress, errorCode, errorMessage },
      });
    } catch (e) {}
  }

  async processItem(data, item) {
    const isStale = () => this.generations.get(item.itemId) !== item.generation;
    const r = { type: 'upload', user: this.userId, taskId: data.taskId, itemId: item.itemId, generation: item.generation, startedAt: now() };
    try {
      await this.report(data, item, 'client_processing', 10);
      await sleep(PROCESSING_MS);
      if (isStale()) return;
      await this.report(data, item, 'client_processing', 30);
      const metadata = {
        actualStartServerMs: data.startServerMs,
        actualEndServerMs: data.endServerMs,
        durationMs: data.endServerMs - data.startServerMs,
        width: 1280,
        height: 720,
        videoCodec: 'vp8',
        container: 'webm',
      };
      const thumb = await this.uploadFile(data, item, THUMB_INFO, 'thumbnail', isStale);
      await api(this.agent, 'POST', `/api/clips/uploads/${thumb.uploadId}/complete`, { headers: this.headers(item), json: { metadata } });
      r.mediaStartedAt = now();
      const media = await this.uploadFile(data, item, MEDIA_INFO, 'media', isStale, r, (ratio) =>
        PROGRESS ? this.report(data, item, 'uploading', 30 + Math.floor(ratio * 65)) : null,
      );
      r.mediaUploadedAt = now();
      if (isStale()) throw Object.assign(new Error('stale'), { code: 'stale_generation' });
      const t = performance.now();
      await api(this.agent, 'POST', `/api/clips/uploads/${media.uploadId}/complete`, {
        headers: this.headers(item),
        json: {
          metadata,
          thumbnail: { mimeType: 'image/jpeg', byteSize: THUMB_INFO.size, checksumSha256: THUMB_INFO.checksum, uploadId: thumb.uploadId },
        },
      });
      r.completeMs = +(performance.now() - t).toFixed(1);
      r.ok = true;
    } catch (e) {
      r.ok = false;
      r.error = e.code || e.message;
      counters.errors++;
      if (!isStale()) await this.report(data, item, 'failed', 0, 'client_failed', String(e.message).slice(0, 500));
    } finally {
      r.endedAt = now();
      if (r.mediaStartedAt && r.mediaUploadedAt) {
        r.uploadMs = +(r.mediaUploadedAt - r.mediaStartedAt).toFixed(1);
        r.mbps = +((MEDIA_INFO.size * 8) / 1e3 / r.uploadMs).toFixed(2);
      }
      results.push(r);
      write(r);
      log(`${this.userId} ${item.itemId} gen${item.generation} ${r.ok ? 'ok' : 'FAIL ' + r.error} upload=${r.uploadMs}ms ${r.mbps || '-'}Mbps complete=${r.completeMs}ms`);
    }
  }

  /** 与 KtB HighlightService.uploadFile 相同的流程：顺序 PATCH，网络错误退避后 HEAD 重同步，409 以服务端 offset 为准 */
  async uploadFile(data, item, info, role, isStale, r, onProgress) {
    const created = await api(this.agent, 'POST', `/api/clips/tasks/${data.taskId}/uploads`, {
      headers: this.headers(item),
      json: { itemId: item.itemId, trackId: item.trackId, role, fileName: info.name, mimeType: info.mimeType, uploadLength: info.size, checksumSha256: info.checksum },
    });
    const uploadUrl = created.uploadUrl || `/api/clips/uploads/${created.uploadId}`;
    let offset = created.offset;
    let retries = 0;
    let resync = false;
    const stats = { chunks: 0, c409: 0, retries: 0, chunkMs: new Histogram(60000, 1) };
    const fd = fs.openSync(info.file, 'r');
    const limited = role === 'media' && this.bucket && PACING !== 'none';
    try {
      while (offset < info.size) {
        if (isStale()) throw Object.assign(new Error('stale'), { code: 'stale_generation' });
        try {
          if (resync) {
            const head = await request(this.agent, 'HEAD', uploadUrl, { headers: this.headers(item) });
            if (head.status !== 204) throw Object.assign(new Error(`HEAD HTTP ${head.status}`), { code: RETRY_5XX && head.status >= 500 ? undefined : 'upload_rejected' });
            offset = Number(head.headers['upload-offset']);
            resync = false;
            continue;
          }
          const len = Math.min(CHUNK, info.size - offset);
          const chunk = Buffer.alloc(len);
          fs.readSync(fd, chunk, 0, len, offset);
          const headers = { ...this.headers(item), 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) };
          if (limited && PACING === 'gap') await this.bucket.take(len);
          const t = performance.now();
          const body =
            limited && PACING === 'smooth'
              ? async (req) => {
                  for (let p = 0; p < len; p += SLICE) {
                    const slice = chunk.subarray(p, Math.min(len, p + SLICE));
                    await this.bucket.take(slice.length);
                    if (req.destroyed) throw new Error('aborted');
                    if (!req.write(slice)) await new Promise((res) => req.once('drain', res));
                  }
                }
              : chunk;
          const resp = await request(this.agent, 'PATCH', uploadUrl, { headers, body, contentLength: len });
          const ms = performance.now() - t;
          if (resp.status === 204 || resp.status === 409) {
            const next = Number(resp.headers['upload-offset']);
            if (role === 'media') {
              stats.chunks++;
              stats.chunkMs.add(ms);
              chunkHist.add(ms);
              counters.chunks++;
              if (resp.status === 409) {
                stats.c409++;
                counters.c409++;
              }
              if (next > offset) counters.ackedBytes += next - offset;
              write({ type: 'chunk', user: this.userId, offset, len, ms: +ms.toFixed(1), status: resp.status });
            }
            offset = next;
            retries = 0;
            if (onProgress) await onProgress(offset / info.size);
            continue;
          }
          // KtB 只对网络错误重试；retry5xx=1 时 5xx（如 Hub 重启期间 nginx 的 502）也按网络错误退避重试
          throw Object.assign(new Error(`PATCH HTTP ${resp.status} ${resp.text}`), { code: RETRY_5XX && resp.status >= 500 ? undefined : 'upload_rejected' });
        } catch (e) {
          if (e.code === 'upload_rejected' || e.code === 'stale_generation' || ++retries > MAX_RETRIES) throw e;
          stats.retries++;
          counters.retries++;
          write({ type: 'event', ev: 'retry', user: this.userId, role, offset, retries, error: e.message });
          await sleep(Math.min(retries * 2000, 10000));
          resync = true;
        }
      }
    } finally {
      fs.closeSync(fd);
      if (r) Object.assign(r, { chunks: stats.chunks, c409: stats.c409, retries: stats.retries, chunkMs: stats.chunkMs.summary() });
    }
    return { uploadId: created.uploadId };
  }
}

const MEDIA_INFO = fileInfo(MEDIA, 'video/webm');
const THUMB_INFO = fileInfo(THUMB, 'image/jpeg');

async function createTask(userId) {
  const end = Date.now() - 1000;
  const t = performance.now();
  const data = await api(directorAgent, 'POST', '/api/clips/tasks', {
    headers: director,
    json: { source: 'manual', userId, trackIds: ['screen'], title: 'stress', category: 'manual', startServerMs: end - DUR_MS, endServerMs: end },
  });
  write({ type: 'event', ev: 'taskCreated', user: userId, taskId: data.task.taskId, ms: +(performance.now() - t).toFixed(1) });
  return data.task;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const config = {
    hub: HUB.origin, uca: UCA, mode: MODE, streams: STREAMS, mbps: STREAM_MBPS, pacingMs: num('pacingMs', 0), players: PLAYERS, items: ITEMS,
    concurrency: CONCURRENCY, media: path.basename(MEDIA), mediaBytes: MEDIA_INFO.size, durMs: DUR_MS, chunk: CHUNK, pacing: PACING,
    limit: args.limit || 'none', limitMbps: LIMIT_MBPS, cap: CAP, tc: args.tc || null, outage: args.outage || null,
    socketDrop: args.socketDrop || null, progress: PROGRESS, label: args.label || null,
  };
  write({ type: 'config', ...config, startedAtIso: new Date().toISOString() });
  log('config', JSON.stringify(config));

  if (args.tc) tcApply(args.tc.split(',').map(Number));

  const players = [];
  if (MODE !== 'none') {
    for (let i = 0; i < PLAYERS; i++) players.push(new Player(`u${String(FIRST_USER + i).padStart(3, '0')}`));
    await Promise.all(players.map((p) => p.connect()));
    log(`${players.length} players ready`);
  }

  const streams = createStreams({ host: ECHO_HOST, port: +ECHO_PORT, streams: STREAMS, mbps: STREAM_MBPS, pacingMs: num('pacingMs', 0) });
  let phase = 'pre';
  const tcPhase = {};
  const markPhase = (name) => {
    phase = name;
    streams.setPhase(name);
    tcPhase[name] = { start: tcStatsSync() };
    write({ type: 'phase', phase: name });
  };
  const endPhase = (name) => {
    if (tcPhase[name]) tcPhase[name].end = tcStatsSync();
  };

  // 每秒一行
  let lastCpu = process.cpuUsage();
  let lastTc = await tcStatsAsync();
  let lastAcked = 0;
  let maxRss = 0;
  const secTimer = setInterval(async () => {
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const rss = process.memoryUsage().rss / 1048576;
    maxRss = Math.max(maxRss, rss);
    const acked = counters.ackedBytes - lastAcked;
    lastAcked = counters.ackedBytes;
    const curTc = await tcStatsAsync();
    const tcDelta = curTc && lastTc ? { mbps: +(((curTc.bytes - lastTc.bytes) * 8) / 1e6).toFixed(2), drops: curTc.netemDrops - lastTc.netemDrops, overlimits: curTc.overlimits - lastTc.overlimits } : null;
    lastTc = curTc;
    const streamSecs = streams.rotate() || [];
    write({
      type: 'sec',
      phase,
      upAckedMbps: +((acked * 8) / 1e6).toFixed(2),
      tc: tcDelta,
      cpuPct: +(((cpu.user + cpu.system) / 1e6) * 100).toFixed(1),
      rssMB: +rss.toFixed(1),
      // 推流统计滞后约 1 s（等帧结算）
      stream: streamSecs[streamSecs.length - 1] || null,
    });
    const s = streamSecs[streamSecs.length - 1];
    if (s && process.stdout.isTTY !== false) {
      log(`${phase} stream ${s.mbps}Mbps loss=${s.lossPct}% frameOk=${s.frameOkPct}% rtt p50/p95=${s.rtt.p50}/${s.rtt.p95} | up ${((acked * 8) / 1e6).toFixed(1)}Mbps${tcDelta ? ` | tc ${tcDelta.mbps}Mbps drops=${tcDelta.drops}` : ''}`);
    }
  }, 1000);

  markPhase('pre');
  await streams.start();
  await sleep((MODE === 'upload' ? PRE : MODE === 'none' ? DUR : PRE) * 1000);
  endPhase('pre');

  if (MODE === 'head') {
    markPhase('upload');
    const sessions = await Promise.all(
      players.map(async (p) => {
        const task = await createTask(p.userId);
        await sleep(1000);
        return { p, task };
      }),
    );
    // 选手端收到的 requestCreateClip 会触发真实上传，head 模式下改为只建会话后循环 HEAD
    const end = performance.now() + DUR * 1000;
    while (performance.now() < end) {
      await Promise.all(sessions.map(({ p }) => p.headSession && request(p.agent, 'HEAD', p.headSession.url, { headers: p.headSession.headers }).then((r) => r.status === 204 && counters.heads++, () => null)));
      await sleep(1000);
    }
    endPhase('upload');
  } else if (MODE === 'upload') {
    markPhase('upload');
    const uploadStart = performance.now();
    const schedule = (spec, fn) => {
      if (!spec) return;
      const [at, dur] = spec.split(',').map(Number);
      setTimeout(async () => {
        write({ type: 'event', ev: 'faultStart', spec });
        log(`fault start ${spec}`);
        await fn(true);
        setTimeout(async () => {
          await fn(false);
          write({ type: 'event', ev: 'faultEnd', spec });
          log(`fault end ${spec}`);
        }, dur * 1000);
      }, at * 1000);
    };
    schedule(args.outage, async (on) => tcLoss(on));
    schedule(args.socketDrop, async (on) => {
      if (on) players.forEach((p) => p.socket.disconnect());
      else await Promise.all(players.map((p) => p.reconnect().catch((e) => log(`${p.userId} reconnect failed: ${e.message}`))));
    });
    const expected = players.length * ITEMS;
    await Promise.all(
      players.flatMap((p) =>
        Array.from({ length: ITEMS }, () =>
          createTask(p.userId).catch((e) => {
            write({ type: 'event', ev: 'taskCreateFailed', user: p.userId, error: e.message });
            results.push({ type: 'upload', user: p.userId, ok: false, error: e.message });
          }),
        ),
      ),
    );
    // 等全部任务项产出最终结果；被重新下发（新 generation）的任务项以最新一代为准
    const deadline = uploadStart + UPLOAD_TIMEOUT * 1000;
    const settled = () => {
      const byItem = new Map();
      for (const r of results) if (r.itemId) byItem.set(r.itemId, r);
      const failedCreates = results.filter((r) => !r.itemId).length;
      const latest = [...byItem.values()].filter((r) => {
        const p = players.find((x) => x.userId === r.user);
        return p.generations.get(r.itemId) === r.generation && r.error !== 'stale_generation';
      });
      return latest.length + failedCreates >= expected;
    };
    while (!settled() && performance.now() < deadline) await sleep(500);
    write({ type: 'event', ev: 'uploadsSettled', ms: +(performance.now() - uploadStart).toFixed(0), timedOut: !settled() });
    endPhase('upload');
    markPhase('post');
    await sleep(POST * 1000);
    endPhase('post');
  }

  clearInterval(secTimer);
  const streamSummary = await streams.stop();
  players.forEach((p) => p.socket && p.socket.disconnect());

  // 删除本轮生成的切片，避免占满 CLIP_MAX_STORAGE_BYTES
  let deleted = 0;
  if (MODE === 'upload' && num('cleanup', 1)) {
    try {
      const list = await api(directorAgent, 'GET', `/api/clips?uca=${UCA}&limit=200`, { headers: director });
      for (const c of list.clips || []) {
        await api(directorAgent, 'DELETE', `/api/clips/${c.clipId}`, { headers: director }).then(() => deleted++, () => null);
      }
    } catch (e) {
      log(`cleanup failed: ${e.message}`);
    }
  }

  const tcSummary = {};
  for (const [name, v] of Object.entries(tcPhase)) {
    if (v.start && v.end) {
      tcSummary[name] = {
        mbps: null,
        bytes: v.end.bytes - v.start.bytes,
        drops: v.end.netemDrops - v.start.netemDrops,
        overlimits: v.end.overlimits - v.start.overlimits,
      };
    }
  }
  const finals = results.filter((r) => r.error !== 'stale_generation');
  const summary = {
    type: 'summary',
    config,
    stream: streamSummary,
    uploads: {
      expected: players.length * ITEMS,
      ok: finals.filter((r) => r.ok).length,
      failed: finals.filter((r) => !r.ok).map((r) => `${r.user}:${r.error}`),
      stale: results.length - finals.length,
      uploadMs: finals.filter((r) => r.uploadMs).map((r) => r.uploadMs),
      mbps: finals.filter((r) => r.mbps).map((r) => r.mbps),
      completeMs: finals.filter((r) => r.completeMs).map((r) => r.completeMs),
      chunkMs: chunkHist.summary(),
      chunks: counters.chunks,
      c409: counters.c409,
      retries: counters.retries,
      requests: players.reduce((a, p) => a + p.requests, 0),
      heads: counters.heads,
      deleted,
    },
    tc: tcSummary,
    proc: { maxRssMB: +maxRss.toFixed(1) },
  };
  write(summary);
  log('summary', JSON.stringify(summary));

  if (args.tc && num('tcClear', 0)) tc('qdisc', 'del', 'dev', DEV, 'root');
  out.end();
  setTimeout(() => process.exit(0), 300);
}

main().catch((e) => {
  console.error('stress aborted:', e);
  write({ type: 'error', error: e.message });
  out.end();
  setTimeout(() => process.exit(1), 300);
});
