/* eslint-disable */
/**
 * 精彩回放上传压测：对比分块大小与并发数对单文件上传耗时的影响。
 *
 * 现有协议单会话只能顺序 PATCH，「并发 N」用同一任务的 N 个 track 会话各传 1/N 文件，
 * 近似模拟按块并发上传（服务端写入路径、SQLite 写队列、网络连接数与真实方案一致）。
 * 不调用 complete（不触发 ffprobe 校验），只测上传阶段。
 *
 * 用法：
 *   HUB=http://127.0.0.1:3099 AUTH_TOKEN=xxx node tests/bench/clip-upload.bench.cjs
 * 可选环境变量：
 *   UCA(contest-a) BENCH_USER_ID(u1) BROADCASTER_TOKEN(test-broadcaster-token)
 *   FILE_MB(64) REPEAT(2) CASES("1M:1,8M:1,1M:4")，格式 <分块大小>:<并发数>
 *   PROBE(1) 先用 4 KiB 小块测量单次 PATCH 的固定开销
 *   LIMIT_MBPS 所有会话合计的上传限速（不设则不限速）
 */
const crypto = require('crypto');
const http = require('http');
const { io } = require('socket.io-client');

const HUB = process.env.HUB || 'http://127.0.0.1:3099';
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const UCA = process.env.UCA || 'contest-a';
const USER_ID = process.env.BENCH_USER_ID || 'u1';
const BROADCASTER_TOKEN = process.env.BROADCASTER_TOKEN || 'test-broadcaster-token';
const FILE_MB = Number(process.env.FILE_MB) || 64;
const REPEAT = Number(process.env.REPEAT) || 2;
const LIMIT_MBPS = Number(process.env.LIMIT_MBPS) || 0;
const CASES = (process.env.CASES || '1M:1,8M:1,1M:4').split(',').map((s) => {
  const [size, conc] = s.split(':');
  const unit = { K: 1024, M: 1024 * 1024 }[size.slice(-1).toUpperCase()] || 1;
  return { label: s, chunk: Math.round(parseFloat(size) * unit), conc: Number(conc) || 1 };
});

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const director = { 'X-UCA': UCA, 'X-Token': AUTH_TOKEN };
const uploader = (token) => ({ 'X-UCA': UCA, 'X-Upload-Token': token });

function request(method, urlPath, { headers = {}, json, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : body;
    const h = { ...headers };
    if (json !== undefined) h['Content-Type'] = 'application/json';
    if (payload !== undefined) h['Content-Length'] = payload.length;
    const req = http.request(`${HUB}${urlPath}`, { method, headers: h, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let data;
        try {
          data = JSON.parse(buf.toString());
        } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json: data });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function api(method, urlPath, opts) {
  const res = await request(method, urlPath, opts);
  if (!(res.json && res.json.success)) {
    throw new Error(`${method} ${urlPath}: ${res.status} ${res.body}`);
  }
  return res.json.data;
}

function connectBroadcaster() {
  const socket = io(`${HUB}/broadcaster`, {
    query: { uca: UCA, userId: USER_ID },
    auth: { id: crypto.randomUUID(), broadcasterToken: BROADCASTER_TOKEN },
    transports: ['websocket'],
    reconnection: false,
  });
  const waiters = new Map();
  socket.on('requestCreateClip', (payload, ack) => {
    ack({ accepted: true });
    const w = waiters.get(payload.taskId);
    w ? w(payload) : waiters.set(payload.taskId, payload);
  });
  const waitRequest = (taskId) =>
    new Promise((resolve) => {
      const got = waiters.get(taskId);
      typeof got === 'object' ? resolve(got) : waiters.set(taskId, resolve);
    });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve({ socket, waitRequest }));
    socket.on('connect_error', reject);
  });
}

/** 创建 N 个 track 的任务，返回 N 个已下发的上传项 */
async function prepareItems(ktb, n) {
  const end = Date.now() - 1000;
  const { task } = await api('POST', '/api/clips/tasks', {
    headers: director,
    json: {
      source: 'manual',
      userId: USER_ID,
      trackIds: Array.from({ length: n }, (_, i) => `bench-${i}`),
      title: 'upload bench',
      category: 'manual',
      maxAttempts: 1,
      startServerMs: end - 3000,
      endServerMs: end,
    },
  });
  const req = await ktb.waitRequest(task.taskId);
  return { taskId: task.taskId, items: req.items };
}

/** 合计限速：按已发送字节数推迟下一块的发送时间 */
const pacer = { start: 0, bytes: 0 };
async function pace(bytes) {
  if (!LIMIT_MBPS) return;
  const due = pacer.start + ((pacer.bytes + bytes) * 8) / (LIMIT_MBPS * 1e3);
  pacer.bytes += bytes;
  const wait = due - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function uploadSession(taskId, item, buf, chunk, latencies) {
  const { uploadId } = await api('POST', `/api/clips/tasks/${taskId}/uploads`, {
    headers: uploader(item.uploadToken),
    json: {
      itemId: item.itemId,
      generation: item.generation,
      trackId: item.trackId,
      role: 'media',
      fileName: 'bench.mp4',
      mimeType: 'video/mp4',
      uploadLength: buf.length,
      checksumSha256: crypto.createHash('sha256').update(buf).digest('hex'),
    },
  });
  for (let offset = 0; offset < buf.length; ) {
    await pace(Math.min(chunk, buf.length - offset));
    const t = process.hrtime.bigint();
    const res = await request('PATCH', `/api/clips/uploads/${uploadId}`, {
      headers: {
        ...uploader(item.uploadToken),
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
      },
      body: buf.subarray(offset, offset + chunk),
    });
    latencies.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (res.status !== 204) {
      throw new Error(`PATCH ${res.status} ${res.body}`);
    }
    offset = Number(res.headers['upload-offset']);
  }
}

/** 结束任务，让 Hub 释放会话 */
async function abort(taskId, items) {
  for (const item of items) {
    await request('POST', `/api/clips/tasks/${taskId}/progress`, {
      headers: uploader(item.uploadToken),
      json: { itemId: item.itemId, generation: item.generation, status: 'failed', progress: 0, errorCode: 'bench_done' },
    }).catch(() => undefined);
  }
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
};

async function main() {
  if (!AUTH_TOKEN) {
    throw new Error('AUTH_TOKEN is required');
  }
  const ktb = await connectBroadcaster();
  const file = crypto.randomBytes(FILE_MB * 1024 * 1024);
  const rows = [];

  if (process.env.PROBE !== '0') {
    const { taskId, items } = await prepareItems(ktb, 1);
    const lat = [];
    await uploadSession(taskId, items[0], file.subarray(0, 4096 * 100), 4096, lat);
    await abort(taskId, items);
    console.log(`probe 4KiB x100: p50=${pct(lat, 50).toFixed(1)}ms p95=${pct(lat, 95).toFixed(1)}ms（单次 PATCH 固定开销）`);
  }

  for (const c of CASES) {
    for (let r = 0; r < REPEAT; r++) {
      const { taskId, items } = await prepareItems(ktb, c.conc);
      const share = Math.ceil(file.length / c.conc);
      const lat = [];
      pacer.start = Date.now();
      pacer.bytes = 0;
      const t = process.hrtime.bigint();
      await Promise.all(
        items.map((item, i) => uploadSession(taskId, item, file.subarray(i * share, (i + 1) * share), c.chunk, lat)),
      );
      const sec = Number(process.hrtime.bigint() - t) / 1e9;
      await abort(taskId, items);
      const row = {
        case: c.label,
        run: r + 1,
        seconds: +sec.toFixed(2),
        mbps: +((file.length * 8) / sec / 1e6).toFixed(1),
        patches: lat.length,
        p50ms: +pct(lat, 50).toFixed(1),
        p95ms: +pct(lat, 95).toFixed(1),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  console.table(rows);
  ktb.socket.close();
  agent.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
