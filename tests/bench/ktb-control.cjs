/* eslint-disable */
/**
 * 对照：用 KtB main（61874bc）的 HighlightService 原样上传一次，与 stress.cjs 在 pacing=none chunk=1M 下的行为比对。
 *
 * 准备：把 KtB 的 src/electron/services/highlight-service.ts 用 typescript.transpileModule 转成 CommonJS，
 *       放到 ktb/highlight-service.js（见 README）。electron-log 用 stub 替代；录像截取用复制预生成文件替代。
 * 用法：NODE_TLS_REJECT_UNAUTHORIZED=0 node ktb-control.cjs hub=https://<hub-host>:49992 token=<AUTH_TOKEN> \
 *         media=media/clip-60s-10M.webm out=outputs/stress/ktb-control/1.jsonl
 */
const Module = require('module');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const args = Object.fromEntries(process.argv.slice(2).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
if (!args.hub) {
  console.error('usage: node ktb-control.cjs hub=https://<hub-host>:49992 token=<AUTH_TOKEN> [media=...]');
  process.exit(2);
}
const HUB = args.hub;
const TOKEN = args.token || process.env.AUTH_TOKEN;
const UCA = `ktb-control-${Date.now().toString(36)}`;
const USER = args.user || 'u001';
const MEDIA = args.media || path.join(__dirname, 'media/clip-60s-10M.webm');
const THUMB = args.thumb || path.join(path.dirname(MEDIA), 'thumb.jpg');
const DUR_MS = +((/(\d+)s-/.exec(path.basename(MEDIA)) || [])[1] || 60) * 1000;
const OUT = args.out || path.join(__dirname, `outputs/stress/ktb-control/${Date.now()}.jsonl`);

const quiet = { info() {}, warn: (...a) => console.warn('[ktb]', ...a), error: (...a) => console.error('[ktb]', ...a) };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron-log') return { __esModule: true, default: quiet };
  return origLoad.call(this, request, ...rest);
};
const { HighlightService } = require(args.service || path.join(__dirname, 'ktb/highlight-service.js'));
const { io } = require('socket.io-client');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const out = fs.createWriteStream(OUT);
const T0 = performance.now();
const write = (o) => out.write(JSON.stringify({ t: +(performance.now() - T0).toFixed(1), ...o }) + '\n');

// 记录 KtB 发出的每个请求
const origFetch = globalThis.fetch;
const patches = [];
globalThis.fetch = async (url, init = {}) => {
  const t = performance.now();
  const res = await origFetch(url, init);
  const ms = performance.now() - t;
  if (init.method === 'PATCH') {
    patches.push(ms);
    write({ type: 'chunk', len: init.body.length, ms: +ms.toFixed(1), status: res.status });
  } else {
    write({ type: 'req', method: init.method, url: String(url).replace(/^https?:\/\/[^/]+/, ''), ms: +ms.toFixed(1), status: res.status });
  }
  return res;
};

const ws = {
  getHttpContext: () => ({ baseURL: HUB, alias: UCA, userId: USER }),
  getServerTimeOffset: async () => 0,
};
let mediaCopiedAt = 0;
const recorder = {
  async cutClip(trackId, startTime, endTime, outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(MEDIA, outPath);
    mediaCopiedAt = performance.now();
    return { success: true, actualStartTime: startTime, actualEndTime: startTime + DUR_MS, durationMs: DUR_MS, width: 1280, height: 720, videoCodec: 'vp8' };
  },
  async extractThumbnail(mediaPath, thumbPath) {
    fs.copyFileSync(THUMB, thumbPath);
    return true;
  },
};
const service = new HighlightService(ws, () => recorder);

async function director(method, route, body) {
  const res = await origFetch(`${HUB}${route}`, {
    method,
    headers: { 'X-UCA': UCA, 'X-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.success) throw new Error(`${method} ${route}: ${json.msg || json.code}`);
  return json.data;
}

(async () => {
  const socket = io(`${HUB}/broadcaster`, {
    query: { uca: UCA, userId: USER },
    auth: { id: crypto.randomUUID(), broadcasterToken: `bt-${USER}` },
    transports: ['websocket'],
    rejectUnauthorized: false,
    reconnection: false,
  });
  socket.on('requestCreateClip', (payload, ack) => ack(service.handleRequest(payload)));
  await new Promise((resolve, reject) => {
    socket.on('connect_error', reject);
    socket.on('connect', () => socket.emit('confirmReady', { tracks: [{ trackId: 'screen', type: 'screen' }] }, resolve));
  });

  const end = Date.now() - 1000;
  const { task } = await director('POST', '/api/clips/tasks', {
    source: 'manual', userId: USER, trackIds: ['screen'], title: 'ktb-control', category: 'manual', startServerMs: end - DUR_MS, endServerMs: end,
  });
  const t0 = performance.now();
  let status;
  for (;;) {
    status = (await director('GET', `/api/clips/tasks/${task.taskId}`)).task;
    if (['ready', 'failed'].includes(status.status)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const sorted = patches.slice().sort((a, b) => a - b);
  const pct = (p) => +sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(1);
  const summary = {
    type: 'summary',
    status: status.status,
    totalMs: +(performance.now() - t0).toFixed(0),
    // 从截取完成（复制文件）到任务 ready，含 sha256、建会话、上传、complete
    sinceCutMs: +(performance.now() - mediaCopiedAt).toFixed(0),
    chunks: patches.length,
    chunkMs: { p50: pct(50), p95: pct(95), max: pct(100) },
    mediaBytes: fs.statSync(MEDIA).size,
  };
  write(summary);
  console.log(JSON.stringify(summary));
  for (const c of (await director('GET', `/api/clips?uca=${UCA}&limit=50`)).clips || []) await director('DELETE', `/api/clips/${c.clipId}`);
  socket.disconnect();
  out.end();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
