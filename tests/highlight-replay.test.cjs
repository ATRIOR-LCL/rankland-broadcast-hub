/* eslint-disable */
/**
 * 精彩回放验收测试（Hub 协议测试端模拟，不代表真实 KtB/KtO 联调）。
 *
 * 前置：pnpm run build；本地 Redis；ffmpeg/ffprobe。
 * 启动真实 Hub 子进程（临时存储目录 + 伪 RL API），用 socket.io-client 和 HTTP 扮演选手端与导播端。
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { io } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');
const AUTH_TOKEN = crypto.randomBytes(16).toString('hex');
const UCA = 'contest-a';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// 环境：测试媒体、伪 RL API、Hub 子进程
// ---------------------------------------------------------------------------

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

function loadMedia(file, mimeType) {
  const buf = fs.readFileSync(file);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', file]));
  return { buf, mimeType, size: buf.length, sha256: sha256(buf), durationMs: Math.round(probe.format.duration * 1000) };
}

const mp4File = path.join(TMP, 'clip.mp4');
const webmFile = path.join(TMP, 'clip.webm');
const pngFile = path.join(TMP, 'thumb.png');
ffmpeg([
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=320x240:rate=25',
  '-t',
  '4',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  mp4File,
]);
ffmpeg([
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=320x240:rate=25',
  '-f',
  'lavfi',
  '-i',
  'sine',
  '-t',
  '4',
  '-c:v',
  'libvpx-vp9',
  '-c:a',
  'libopus',
  webmFile,
]);
ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=160x120', '-frames:v', '1', pngFile]);
const MP4 = loadMedia(mp4File, 'video/mp4');
const WEBM = loadMedia(webmFile, 'video/webm');
const pngBuf = fs.readFileSync(pngFile);
const PNG = { buf: pngBuf, mimeType: 'image/png', size: pngBuf.length, sha256: sha256(pngBuf) };

const members = { u1: 'bt-u1', u2: 'bt-u2', u3: 'bt-u3' };
const rlApi = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname.endsWith('/getLiveContest')) {
    return send({
      success: true,
      code: 0,
      data: { alias: UCA, contest: { startAt: new Date().toISOString(), duration: [5, 'h'] } },
    });
  }
  const userId = url.searchParams.get('userId');
  if (url.pathname.endsWith('/getContestMember') && members[userId]) {
    return send({
      success: true,
      code: 0,
      data: { id: userId, name: userId, banned: false, broadcasterToken: members[userId] },
    });
  }
  send({ success: false, code: 100002 });
});

const PORT = 39000 + Math.floor(Math.random() * 1000);
const HUB = `http://127.0.0.1:${PORT}`;
const hubEnv = {
  ...process.env,
  NODE_ENV: 'development',
  SERVER_PORT: String(PORT),
  AUTH_TOKEN,
  CLIP_STORAGE_DIR: path.join(TMP, 'store'),
  CLIP_RETRY_DELAY_MS: '300',
};
let hub = null;

async function startHub() {
  hub = spawn(process.execPath, [path.join(ROOT, 'app/server/index.js')], {
    cwd: ROOT,
    env: hubEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  hub.stdout.on('data', (c) => (log += c));
  hub.stderr.on('data', (c) => (log += c));
  for (let i = 0; i < 100 && !log.includes('A bwcx app is listening'); i++) {
    await sleep(100);
  }
  assert.ok(log.includes('A bwcx app is listening'), `hub failed to start:\n${log}`);
}

async function stopHub(signal = 'SIGTERM') {
  const proc = hub;
  hub = null;
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.on('exit', r));
    proc.kill(signal);
    await exited;
  }
}

// ---------------------------------------------------------------------------
// 协议测试端
// ---------------------------------------------------------------------------

function request(method, urlPath, { headers = {}, json, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : body;
    const h = { ...headers };
    if (json !== undefined) h['Content-Type'] = 'application/json';
    if (payload !== undefined) h['Content-Length'] = payload.length;
    const req = http.request(`${HUB}${urlPath}`, { method, headers: h }, (res) => {
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

const director = { 'X-UCA': UCA, 'X-Token': AUTH_TOKEN };
const uploader = (token) => ({ 'X-UCA': UCA, 'X-Upload-Token': token });

/** JSON 接口：断言成功并返回 data */
async function api(method, urlPath, opts) {
  const res = await request(method, urlPath, opts);
  assert.strictEqual(res.json && res.json.success, true, `${method} ${urlPath}: ${res.body}`);
  return res.json.data;
}

/** 选手端：收到的请求进入队列，ack 由 onRequest 决定 */
function connectBroadcaster(userId, onRequest = () => ({ accepted: true })) {
  const socket = io(`${HUB}/broadcaster`, {
    query: { uca: UCA, userId },
    auth: { id: crypto.randomUUID(), broadcasterToken: members[userId] },
    transports: ['websocket'],
    reconnection: false,
  });
  const queue = [];
  const waiters = [];
  socket.on('requestCreateClip', (payload, ack) => {
    ack(onRequest(payload));
    waiters.length ? waiters.shift()(payload) : queue.push(payload);
  });
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));
  return new Promise((resolve) => socket.on('connect', () => resolve({ socket, next })));
}

function connectClips(filter) {
  const socket = io(`${HUB}/clips`, {
    query: { uca: UCA },
    auth: { directorToken: AUTH_TOKEN },
    transports: ['websocket'],
    reconnection: false,
  });
  const events = [];
  ['clipTaskUpdated', 'clipCreated', 'clipDeleted'].forEach((e) => socket.on(e, (data) => events.push({ e, data })));
  return new Promise((resolve) =>
    socket.on('connect', () => socket.emit('subscribeClips', filter, () => resolve({ socket, events }))),
  );
}

function window(media) {
  const end = Date.now() - 1000;
  const start = end - (media.durationMs - 1000);
  return {
    startServerMs: start,
    endServerMs: end,
    actualStartServerMs: start - 500,
    actualEndServerMs: start - 500 + media.durationMs,
  };
}

async function createTask(win, extra = {}) {
  return (
    await api('POST', '/api/clips/tasks', {
      headers: director,
      json: {
        source: 'manual',
        userId: 'u1',
        trackIds: ['screen'],
        title: 'test',
        category: 'manual',
        ...extra,
        startServerMs: win.startServerMs,
        endServerMs: win.endServerMs,
      },
    })
  ).task;
}

async function createUpload(taskId, item, media, role = 'media') {
  return api('POST', `/api/clips/tasks/${taskId}/uploads`, {
    headers: uploader(item.uploadToken),
    json: {
      itemId: item.itemId,
      generation: item.generation,
      trackId: item.trackId,
      role,
      fileName: `f.${role}`,
      mimeType: media.mimeType,
      uploadLength: media.size,
      checksumSha256: media.sha256,
    },
  });
}

function patch(uploadId, token, offset, buf) {
  return request('PATCH', `/api/clips/uploads/${uploadId}`, {
    headers: { ...uploader(token), 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) },
    body: buf,
  });
}

async function uploadAll(uploadId, token, buf, from = 0) {
  for (let offset = from; offset < buf.length; ) {
    const res = await patch(uploadId, token, offset, buf.subarray(offset, offset + 8192));
    assert.strictEqual(res.status, 204, `PATCH ${res.status}`);
    offset = Number(res.headers['upload-offset']);
  }
}

function complete(uploadId, token, media, win, extra = {}) {
  return request('POST', `/api/clips/uploads/${uploadId}/complete`, {
    headers: uploader(token),
    json: {
      metadata: {
        actualStartServerMs: win.actualStartServerMs,
        actualEndServerMs: win.actualEndServerMs,
        durationMs: media.durationMs,
        container: media.mimeType === 'video/mp4' ? 'mp4' : 'webm',
      },
      ...extra,
    },
  });
}

/** 选手端完整流程：进度 → 上传（可选缩略图）→ complete */
async function produce(taskId, item, media, win, { thumbnail = false } = {}) {
  await api('POST', `/api/clips/tasks/${taskId}/progress`, {
    headers: uploader(item.uploadToken),
    json: { itemId: item.itemId, generation: item.generation, status: 'client_processing', progress: 30 },
  });
  let thumb;
  if (thumbnail) {
    const t = await createUpload(taskId, item, PNG, 'thumbnail');
    await uploadAll(t.uploadId, item.uploadToken, PNG.buf);
    thumb = { mimeType: PNG.mimeType, byteSize: PNG.size, checksumSha256: PNG.sha256, uploadId: t.uploadId };
  }
  const { uploadId } = await createUpload(taskId, item, media);
  await uploadAll(uploadId, item.uploadToken, media.buf);
  const res = await complete(uploadId, item.uploadToken, media, win, thumb ? { thumbnail: thumb } : {});
  assert.strictEqual(res.json.success, true, res.body.toString());
  return uploadId;
}

async function waitTask(taskId, statuses) {
  for (let i = 0; i < 150; i++) {
    const { task } = await api('GET', `/api/clips/tasks/${taskId}`, { headers: director });
    if (statuses.includes(task.status)) return task;
    await sleep(100);
  }
  throw new Error(`task ${taskId} did not reach ${statuses}`);
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let u1;

test('SC-001 单 track 取片：下发、上传、校验后生成 ready 切片并推送', async () => {
  const sub = await connectClips({ userIds: ['u1'] });
  const win = window(MP4);
  const task = await createTask(win);
  const req = await u1.next();
  assert.strictEqual(req.taskId, task.taskId);
  assert.strictEqual(req.items[0].generation, 1);
  const verifying = await produce(task.taskId, req.items[0], MP4, win, { thumbnail: true });
  assert.ok(verifying);
  const done = await waitTask(task.taskId, ['ready', 'failed']);
  assert.strictEqual(done.status, 'ready');
  assert.strictEqual(done.createdClipIds.length, 1);
  await sleep(200);
  assert.ok(sub.events.some((e) => e.e === 'clipCreated' && e.data.clip.clipId === done.createdClipIds[0]));
  sub.socket.close();
});

test('SC-005 列表可见，HEAD/Range 播放，缩略图可读，越界 416', async () => {
  const { clips } = await api('GET', '/api/clips?userId=u1', { headers: director });
  const clip = clips[0];
  assert.strictEqual(clip.videoCodec, 'h264');
  assert.strictEqual(clip.byteSize, MP4.size);
  const head = await request('HEAD', clip.mediaUrl, { headers: director });
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.headers['content-length'], String(MP4.size));
  assert.strictEqual(head.headers['accept-ranges'], 'bytes');
  const full = await request('GET', clip.mediaUrl, { headers: director });
  assert.strictEqual(sha256(full.body), MP4.sha256);
  const part = await request('GET', clip.mediaUrl, { headers: { ...director, Range: 'bytes=100-199' } });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.headers['content-range'], `bytes 100-199/${MP4.size}`);
  assert.ok(part.body.equals(MP4.buf.subarray(100, 200)));
  const suffix = await request('GET', clip.mediaUrl, { headers: { ...director, Range: 'bytes=-10' } });
  assert.ok(suffix.body.equals(MP4.buf.subarray(MP4.size - 10)));
  const bad = await request('GET', clip.mediaUrl, { headers: { ...director, Range: `bytes=${MP4.size}-` } });
  assert.strictEqual(bad.status, 416);
  assert.strictEqual(bad.headers['content-range'], `bytes */${MP4.size}`);
  const thumb = await request('GET', clip.thumbnailUrl, { headers: director });
  assert.strictEqual(sha256(thumb.body), PNG.sha256);
  // 鉴权失败沿用现有 GuardNotPassExceptionHandler：HTTP 200 + Resp code -4，不返回媒体内容
  const noAuth = await request('GET', clip.mediaUrl, { headers: { 'X-UCA': UCA } });
  assert.strictEqual(noAuth.json.code, -4);
  assert.notStrictEqual(sha256(noAuth.body), MP4.sha256);
});

test('多 track：一路成功一路 recording_range_missing → partial_ready；幂等创建返回同一任务', async () => {
  const win = window(WEBM);
  const task = await createTask(win, { trackIds: ['screen', 'camera'], idempotencyKey: 'multi-1' });
  const again = await createTask(win, { trackIds: ['screen', 'camera'], idempotencyKey: 'multi-1' });
  assert.strictEqual(again.taskId, task.taskId);
  const req = await u1.next();
  assert.strictEqual(req.items.length, 2);
  const [ok, bad] = req.items;
  await produce(task.taskId, ok, WEBM, win);
  await api('POST', `/api/clips/tasks/${task.taskId}/progress`, {
    headers: uploader(bad.uploadToken),
    json: {
      itemId: bad.itemId,
      generation: bad.generation,
      status: 'failed',
      progress: 0,
      errorCode: 'recording_range_missing',
    },
  });
  const done = await waitTask(task.taskId, ['partial_ready', 'ready', 'failed']);
  assert.strictEqual(done.status, 'partial_ready');
  assert.strictEqual(done.items.find((i) => i.itemId === bad.itemId).errorCode, 'recording_range_missing');
});

test('SC-002 选手离线：重试 3 次后失败；ACK 拒绝 track_not_found 不重试', async () => {
  const win = window(MP4);
  const offline = await createTask(win, { userId: 'u3' });
  const failed = await waitTask(offline.taskId, ['failed']);
  assert.strictEqual(failed.attempts, 3);
  assert.strictEqual(failed.items[0].errorCode, 'target_offline');

  await connectBroadcaster('u2', () => ({ accepted: false, errorCode: 'track_not_found' }));
  const rejected = await createTask(win, { userId: 'u2' });
  const done = await waitTask(rejected.taskId, ['failed']);
  assert.strictEqual(done.attempts, 1);
  assert.strictEqual(done.items[0].errorCode, 'track_not_found');
});

test('SC-003 offset 冲突返回 409；Hub 重启后 HEAD 取 offset 继续上传', async () => {
  const win = window(MP4);
  const task = await createTask(win);
  const item = (await u1.next()).items[0];
  const { uploadId } = await createUpload(task.taskId, item, MP4);
  const half = Math.floor(MP4.size / 2);
  assert.strictEqual((await patch(uploadId, item.uploadToken, 0, MP4.buf.subarray(0, half))).status, 204);
  const conflict = await patch(uploadId, item.uploadToken, 0, MP4.buf.subarray(0, 100));
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(conflict.headers['upload-offset'], String(half));

  await stopHub('SIGKILL');
  await startHub();
  u1 = await connectBroadcaster('u1');
  const head = await request('HEAD', `/api/clips/uploads/${uploadId}`, { headers: uploader(item.uploadToken) });
  assert.strictEqual(head.status, 204);
  assert.strictEqual(head.headers['upload-offset'], String(half));
  await uploadAll(uploadId, item.uploadToken, MP4.buf, half);
  assert.strictEqual((await complete(uploadId, item.uploadToken, MP4, win)).json.success, true);
  const done = await waitTask(task.taskId, ['ready', 'failed']);
  assert.strictEqual(done.status, 'ready');
  const { clips } = await api('GET', '/api/clips', { headers: director });
  assert.strictEqual(clips.find((c) => c.clipId === done.createdClipIds[0]).checksumSha256, MP4.sha256);
});

test('SC-004 checksum 不符、时长不符均不生成切片', async () => {
  const win = window(MP4);
  const task = await createTask(win, { trackIds: ['a', 'b'] });
  const [i1, i2] = (await u1.next()).items;
  const corrupted = Buffer.from(MP4.buf);
  corrupted[corrupted.length - 1] ^= 0xff;
  const up1 = await createUpload(task.taskId, i1, MP4);
  await uploadAll(up1.uploadId, i1.uploadToken, corrupted);
  await complete(up1.uploadId, i1.uploadToken, MP4, win);
  const up2 = await createUpload(task.taskId, i2, MP4);
  await uploadAll(up2.uploadId, i2.uploadToken, MP4.buf);
  await complete(up2.uploadId, i2.uploadToken, { ...MP4, durationMs: MP4.durationMs + 3000 }, win);
  const done = await waitTask(task.taskId, ['failed', 'partial_ready', 'ready']);
  assert.strictEqual(done.status, 'failed');
  assert.strictEqual(done.items.find((i) => i.itemId === i1.itemId).errorCode, 'upload_checksum_mismatch');
  assert.strictEqual(done.items.find((i) => i.itemId === i2.itemId).errorCode, 'media_validation_failed');
  assert.strictEqual(done.createdClipIds.length, 0);
});

test('upload token 不能访问导播接口；删除后列表不可见、媒体 404', async () => {
  const { clips } = await api('GET', '/api/clips', { headers: director });
  const clip = clips[0];
  const asUploader = await request('GET', '/api/clips', {
    headers: { 'X-UCA': UCA, 'X-Token': 'not-a-director-token' },
  });
  assert.notStrictEqual(asUploader.json.success, true);
  await api('DELETE', `/api/clips/${clip.clipId}`, { headers: director });
  await api('DELETE', `/api/clips/${clip.clipId}`, { headers: director });
  const after = await api('GET', '/api/clips', { headers: director });
  assert.ok(!after.clips.some((c) => c.clipId === clip.clipId));
  assert.strictEqual((await request('GET', clip.mediaUrl, { headers: director })).status, 404);
});

(async () => {
  await new Promise((r) => rlApi.listen(0, '127.0.0.1', r));
  hubEnv.RL_API_URL = `http://127.0.0.1:${rlApi.address().port}/api`;
  execFileSync(
    process.execPath,
    ['node_modules/typeorm/cli.js', 'migration:run', '-d', 'app/server/database/typeorm-cli-data-source.js'],
    {
      cwd: ROOT,
      env: hubEnv,
      stdio: 'ignore',
    },
  );
  await startHub();
  u1 = await connectBroadcaster('u1');
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${t.name}\n${e.stack}`);
    }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  await stopHub();
  rlApi.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
