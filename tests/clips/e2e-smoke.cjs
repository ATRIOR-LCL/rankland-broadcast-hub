/* eslint-disable */
/**
 * 精彩回放链路冒烟（启动真实 Hub 子进程，扮演 KtB / KtO 走完整 HTTP + Socket.io 链路）。
 *
 * 前置：pnpm run build；本地 Redis；ffmpeg/ffprobe；
 *       SOCKET_IO_CLIENT 指向任意 socket.io-client 目录（Hub 本身不依赖它）。
 * 用法：SOCKET_IO_CLIENT=~/GitHub/Kessoku-the-Broadcaster/node_modules/socket.io-client node tests/clips/e2e-smoke.cjs
 *
 * 每个场景独立打印 PASS / FAIL，不在首个失败处中断，用于定位链路问题。
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { once } = require('events');
const { io } = require(process.env.SOCKET_IO_CLIENT || 'socket.io-client');

const ROOT = path.resolve(__dirname, '../..');
const AUTH_TOKEN = crypto.randomBytes(16).toString('hex');
const UCA = `clip-smoke-${crypto.randomBytes(4).toString('hex')}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-smoke-'));
const UPLOAD_TTL_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// 测试媒体、伪 RL API、Hub 子进程
// ---------------------------------------------------------------------------

const webmFile = path.join(TMP, 'clip.webm');
const jpgFile = path.join(TMP, 'thumb.jpg');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '3', '-c:v', 'libvpx-vp9', webmFile]);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120', '-frames:v', '1', jpgFile]);
const load = (file, mimeType) => {
  const buf = fs.readFileSync(file);
  return { buf, mimeType, size: buf.length, sha256: sha256(buf) };
};
const WEBM = load(webmFile, 'video/webm');
const JPG = load(jpgFile, 'image/jpeg');

const members = { u1: 'bt-u1', u2: 'bt-u2', u3: 'bt-u3', u4: 'bt-u4' };
const rlApi = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === `/api/v2/public/contests/${UCA}`) {
    return send({ success: true, code: 0, data: { uk: UCA, title: UCA, startAt: new Date().toISOString(), duration: [5, 'h'] } });
  }
  const userId = url.pathname.match(new RegExp(`^/api/v2/contests/${UCA}/users/([^/]+)$`))?.[1];
  if (userId && members[userId]) {
    return send({ success: true, code: 0, data: { id: userId, name: userId, banned: false, broadcasterToken: members[userId] } });
  }
  send({ success: false, code: 100002 });
});

const PORT = 39000 + Math.floor(Math.random() * 1000);
const HUB = `http://127.0.0.1:${PORT}`;
let hub = null;
let hubLog = '';

async function startHub(rlPort) {
  hub = spawn(process.execPath, [path.join(ROOT, 'app/server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      SERVER_PORT: String(PORT),
      AUTH_TOKEN,
      RL_API_URL: `http://127.0.0.1:${rlPort}/api/v2`,
      CLIP_STORAGE_DIR: path.join(TMP, 'store'),
      CLIP_UPLOAD_TOKEN_TTL_MS: String(UPLOAD_TTL_MS),
      CLIP_REQUEST_ACK_TIMEOUT_MS: '1000',
      CLIP_UPLOAD_IDLE_TIMEOUT_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hub.stdout.on('data', (c) => (hubLog += c));
  hub.stderr.on('data', (c) => (hubLog += c));
  for (let i = 0; i < 150 && !hubLog.includes('A bwcx app is listening'); i++) {
    await sleep(100);
  }
  assert.ok(hubLog.includes('A bwcx app is listening'), `hub failed to start:\n${hubLog}`);
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

async function api(method, urlPath, opts) {
  const res = await request(method, urlPath, opts);
  assert.strictEqual(res.json && res.json.success, true, `${method} ${urlPath}: HTTP ${res.status} ${res.body}`);
  return res.json.data;
}

/** 选手端：confirmReady 后才会被 Hub 视为在线；onRequest 返回 ack，返回 undefined 表示不 ack */
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
    const res = onRequest(payload);
    if (res) ack(res);
    waiters.length ? waiters.shift()(payload) : queue.push(payload);
  });
  const next = (timeoutMs = 5000) =>
    queue.length
      ? Promise.resolve(queue.shift())
      : Promise.race([
          new Promise((r) => waiters.push(r)),
          sleep(timeoutMs).then(() => {
            throw new Error('requestCreateClip not received');
          }),
        ]);
  const nextFor = async (taskId) => {
    for (;;) {
      const payload = await next();
      if (payload.taskId === taskId) return payload;
    }
  };
  return new Promise((resolve, reject) => {
    socket.on('connect_error', reject);
    socket.on('connect', () => {
      socket.emit('confirmReady', { tracks: [{ trackId: 'screen', type: 'screen' }] }, (res) => {
        if (!res || res.success === false) return reject(new Error(`confirmReady failed: ${JSON.stringify(res)}`));
        resolve({ socket, next, nextFor });
      });
    });
  });
}

function windowNow(ms = 3000) {
  const end = Date.now() - 500;
  return { startServerMs: end - ms, endServerMs: end };
}

async function createTask(userId, win = windowNow()) {
  return (
    await api('POST', '/api/clips/tasks', {
      headers: director,
      json: { source: 'manual', userId, trackIds: ['screen'], title: 'smoke', category: 'manual', ...win },
    })
  ).task;
}

async function getTask(taskId) {
  return (await api('GET', `/api/clips/tasks/${taskId}`, { headers: director })).task;
}

async function createUpload(taskId, item, media, role) {
  return api('POST', `/api/clips/tasks/${taskId}/uploads`, {
    headers: uploader(item.uploadToken),
    json: { itemId: item.itemId, trackId: item.trackId, role, fileName: `f.${role}`, mimeType: media.mimeType, uploadLength: media.size, checksumSha256: media.sha256 },
  });
}

function patch(uploadId, token, offset, buf) {
  return request('PATCH', `/api/clips/uploads/${uploadId}`, {
    headers: { ...uploader(token), 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) },
    body: buf,
  });
}

async function uploadAll(uploadId, token, buf, chunk = 64 * 1024, delayMs = 0) {
  let offset = 0;
  while (offset < buf.length) {
    const res = await patch(uploadId, token, offset, buf.subarray(offset, offset + chunk));
    assert.strictEqual(res.status, 204, `PATCH @${offset}: HTTP ${res.status} ${res.body}`);
    offset = Number(res.headers['upload-offset']);
    if (delayMs) await sleep(delayMs);
  }
}

function metadata(win) {
  return {
    actualStartServerMs: win.startServerMs,
    actualEndServerMs: win.endServerMs,
    durationMs: win.endServerMs - win.startServerMs,
    width: 320,
    height: 240,
    videoCodec: 'vp9',
    container: 'webm',
  };
}


/** 声明完整 Content-Length 但只写入前 sendBytes 字节，然后断开（abort）或保持连接不再发送（stall） */
function partialPatch(uploadId, token, offset, buf, sendBytes, mode) {
  const req = http.request(`${HUB}/api/clips/uploads/${uploadId}`, {
    method: 'PATCH',
    headers: { ...uploader(token), 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset), 'Content-Length': buf.length },
  });
  const done = new Promise((resolve) => {
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve('error'));
  });
  req.write(buf.subarray(0, sendBytes));
  if (mode === 'abort') {
    setTimeout(() => req.destroy(), 200);
  }
  return { req, done };
}

async function headOffset(uploadId, token) {
  const res = await request('HEAD', `/api/clips/uploads/${uploadId}`, { headers: uploader(token) });
  assert.strictEqual(res.status, 204, `HEAD upload: HTTP ${res.status}`);
  return Number(res.headers['upload-offset']);
}

/** 从 HEAD 给出的 offset 续传到结束并 complete，校验最终切片字节一致 */
async function resumeAndComplete(uploadId, token, buf, win, chunk = 64 * 1024) {
  let offset = await headOffset(uploadId, token);
  while (offset < buf.length) {
    const res = await patch(uploadId, token, offset, buf.subarray(offset, offset + chunk));
    assert.strictEqual(res.status, 204, `PATCH @${offset}: HTTP ${res.status} ${res.body}`);
    offset = Number(res.headers['upload-offset']);
  }
  const done = await api('POST', `/api/clips/uploads/${uploadId}/complete`, { headers: uploader(token), json: { metadata: metadata(win) } });
  assert.ok(done.clip, 'complete returned no clip');
  const media = await request('GET', `/api/clips/${done.clip.clipId}/media`, { headers: director });
  assert.ok(media.body.equals(buf), 'stored media differs from source');
}

/** 为 u1 新建任务与媒体上传会话 */
async function newMediaUpload(b) {
  const w = windowNow();
  const t = await createTask('u1', w);
  const p = (await b.nextFor(t.taskId)).items[0];
  const media = await createUpload(t.taskId, p, WEBM, 'media');
  return { w, token: p.uploadToken, uploadId: media.uploadId };
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}

async function main() {
  await new Promise((r) => rlApi.listen(0, '127.0.0.1', r));
  await startHub(rlApi.address().port);

  const b1 = await connectBroadcaster('u1');
  const win = windowNow();
  let task;
  let item;
  let clip;

  await scenario('createTask 后选手端收到 requestCreateClip', async () => {
    task = await createTask('u1', win);
    const payload = await b1.next();
    assert.strictEqual(payload.taskId, task.taskId);
    item = payload.items[0];
  });

  await scenario('ack accepted 后任务项离开 requested', async () => {
    await sleep(300);
    const t = await getTask(task.taskId);
    assert.notStrictEqual(t.items[0].status, 'requested', `item status still ${t.items[0].status}`);
  });

  await scenario('KtB 用 X-Upload-Token 上报进度', async () => {
    await api('POST', `/api/clips/tasks/${task.taskId}/progress`, {
      headers: uploader(item.uploadToken),
      json: { itemId: item.itemId, status: 'client_processing', progress: 10 },
    });
  });

  await scenario('缩略图 + 媒体上传、complete 生成切片', async () => {
    const thumb = await createUpload(task.taskId, item, JPG, 'thumbnail');
    await uploadAll(thumb.uploadId, item.uploadToken, JPG.buf);
    await api('POST', `/api/clips/uploads/${thumb.uploadId}/complete`, { headers: uploader(item.uploadToken), json: { metadata: metadata(win) } });
    const media = await createUpload(task.taskId, item, WEBM, 'media');
    const head0 = await request('HEAD', `/api/clips/uploads/${media.uploadId}`, { headers: uploader(item.uploadToken) });
    assert.strictEqual(head0.status, 204, `HEAD upload: HTTP ${head0.status}`);
    assert.strictEqual(head0.headers['upload-offset'], '0');
    await uploadAll(media.uploadId, item.uploadToken, WEBM.buf);
    const done = await api('POST', `/api/clips/uploads/${media.uploadId}/complete`, {
      headers: uploader(item.uploadToken),
      json: {
        metadata: metadata(win),
        thumbnail: { uploadId: thumb.uploadId, mimeType: JPG.mimeType, byteSize: JPG.size, checksumSha256: JPG.sha256 },
      },
    });
    clip = done.clip || (await api('GET', `/api/clips?uca=${UCA}`, { headers: director })).clips[0];
    assert.ok(clip, 'no clip created');
    assert.strictEqual((await getTask(task.taskId)).status, 'ready');
  });

  await scenario('GET media 返回原始字节', async () => {
    const res = await request('GET', `/api/clips/${clip.clipId}/media`, { headers: director });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.equals(WEBM.buf), `body mismatch: content-type=${res.headers['content-type']} body=${res.body.subarray(0, 80)}`);
  });

  await scenario('GET media Range 返回 206 与对应字节', async () => {
    const res = await request('GET', `/api/clips/${clip.clipId}/media`, { headers: { ...director, Range: 'bytes=10-19' } });
    assert.strictEqual(res.status, 206);
    assert.ok(res.body.equals(WEBM.buf.subarray(10, 20)), `body=${res.body.subarray(0, 80)}`);
  });

  await scenario('HEAD media 无 body、Content-Length 为文件大小', async () => {
    const res = await request('HEAD', `/api/clips/${clip.clipId}/media`, { headers: director });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(Number(res.headers['content-length']), WEBM.size);
  });

  await scenario('GET thumbnail 返回原始字节', async () => {
    const res = await request('GET', `/api/clips/${clip.clipId}/thumbnail`, { headers: director });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.equals(JPG.buf), `content-type=${res.headers['content-type']} body=${res.body.subarray(0, 80)}`);
  });

  await scenario('KtB 上报 failed 后任务进入重试或失败', async () => {
    const t = await createTask('u1');
    const p = await b1.nextFor(t.taskId);
    await request('POST', `/api/clips/tasks/${t.taskId}/progress`, {
      headers: uploader(p.items[0].uploadToken),
      json: { itemId: p.items[0].itemId, status: 'failed', progress: 0, errorCode: 'recording_range_missing' },
    });
    const after = await getTask(t.taskId);
    assert.strictEqual(after.status, 'failed', `task status ${after.status}`);
  });

  await scenario('ack 后选手端断线，任务不应永久卡住（等待 TTL 后应重新排队/失败）', async () => {
    const b2 = await connectBroadcaster('u2');
    const t = await createTask('u2');
    await b2.next();
    b2.socket.disconnect();
    await sleep(UPLOAD_TTL_MS + 2500);
    const after = await getTask(t.taskId);
    assert.ok(['queued', 'failed'].includes(after.status), `task status ${after.status} after token TTL`);
  });

  await scenario('ack 超时：重试应有间隔，而不是立即连发', async () => {
    const b3 = await connectBroadcaster('u3', () => undefined);
    const t = await createTask('u3');
    const times = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        await b3.next(deadline - Date.now());
        times.push(Date.now());
      } catch (e) {
        break;
      }
    }
    const after = await getTask(t.taskId);
    console.log(`      requestCreateClip x${times.length} in 5s, attempts=${after.attempts}, status=${after.status}`);
    const gaps = times.slice(1).map((x, i) => x - times[i]);
    assert.ok(gaps.every((g) => g >= 1500), `retry gaps (ms): ${gaps.join(', ')}`);
    b3.socket.disconnect();
  });

  await scenario('限速慢上传超过会话 TTL 仍能完成', async () => {
    const b4 = await connectBroadcaster('u4');
    const w = windowNow();
    const t = await createTask('u4', w);
    const p = (await b4.next()).items[0];
    const media = await createUpload(t.taskId, p, WEBM, 'media');
    const chunk = Math.ceil(WEBM.size / 6);
    await uploadAll(media.uploadId, p.uploadToken, WEBM.buf, chunk, UPLOAD_TTL_MS / 4);
    await api('POST', `/api/clips/uploads/${media.uploadId}/complete`, { headers: uploader(p.uploadToken), json: { metadata: metadata(w) } });
  });

  // ---------------- 断点续传 ----------------

  await scenario('[续传] Upload-Offset 不一致返回 409 与服务端 offset', async () => {
    const { token, uploadId } = await newMediaUpload(b1);
    await patch(uploadId, token, 0, WEBM.buf.subarray(0, 4096));
    const res = await patch(uploadId, token, 1000, WEBM.buf.subarray(1000, 2000));
    assert.strictEqual(res.status, 409, `HTTP ${res.status} ${res.body}`);
    assert.strictEqual(res.headers['upload-offset'], '4096');
  });

  await scenario('[续传] PATCH 中途断连后 HEAD 得到一致 offset，可续传完成', async () => {
    const { w, token, uploadId } = await newMediaUpload(b1);
    await patch(uploadId, token, 0, WEBM.buf.subarray(0, 4096));
    const p = partialPatch(uploadId, token, 4096, WEBM.buf.subarray(4096), 8000, 'abort');
    await p.done;
    await sleep(300);
    const off = await headOffset(uploadId, token);
    console.log(`      offset after abort = ${off}`);
    assert.ok(off >= 4096 && off <= 4096 + 8000, `offset ${off}`);
    await resumeAndComplete(uploadId, token, WEBM.buf, w);
  });

  await scenario('[续传] 旧连接半开卡住时，新连接能在 30s 内续传', async () => {
    const { w, token, uploadId } = await newMediaUpload(b1);
    const stalled = partialPatch(uploadId, token, 0, WEBM.buf, 8000, 'stall');
    await sleep(500);
    const t0 = Date.now();
    const off = await headOffset(uploadId, token);
    const res = await Promise.race([
      patch(uploadId, token, off, WEBM.buf.subarray(off, off + 4096)),
      sleep(30000).then(() => ({ status: 'timeout' })),
    ]);
    console.log(`      HEAD offset=${off}, new PATCH -> ${res.status} after ${Date.now() - t0}ms`);
    stalled.req.destroy();
    assert.ok(res.status === 204 || res.status === 409, `new PATCH ${res.status}`);
    await resumeAndComplete(uploadId, token, WEBM.buf, w);
  });

  await scenario('[续传] 同一 offset 并发 PATCH 只有一个成功，另一个 409', async () => {
    const { w, token, uploadId } = await newMediaUpload(b1);
    const part = WEBM.buf.subarray(0, 8192);
    const codes = (await Promise.all([patch(uploadId, token, 0, part), patch(uploadId, token, 0, part)])).map((r) => r.status).sort();
    assert.deepStrictEqual(codes, [204, 409]);
    assert.strictEqual(await headOffset(uploadId, token), 8192);
    await resumeAndComplete(uploadId, token, WEBM.buf, w);
  });

  await scenario('[续传] 超出 uploadLength 的分块被拒绝且 offset 不变', async () => {
    const { token, uploadId } = await newMediaUpload(b1);
    const res = await patch(uploadId, token, 0, Buffer.concat([WEBM.buf, Buffer.alloc(10)]));
    assert.notStrictEqual(res.status, 204, 'oversize chunk accepted');
    assert.strictEqual(await headOffset(uploadId, token), 0);
  });

  await scenario('拒绝起点在未来的时间窗', async () => {
    const res = await request('POST', '/api/clips/tasks', {
      headers: director,
      json: { source: 'manual', userId: 'u1', trackIds: ['screen'], title: 'future', category: 'manual', startServerMs: Date.now() + 30000, endServerMs: Date.now() + 60000 },
    });
    assert.strictEqual(res.json && res.json.success, false, 'future window accepted');
  });

  await scenario('允许终点在未来的时间窗（postRoll）', async () => {
    const res = await request('POST', '/api/clips/tasks', {
      headers: director,
      json: { source: 'manual', userId: 'u1', trackIds: ['screen'], title: 'post-roll', category: 'manual', startServerMs: Date.now() - 5000, endServerMs: Date.now() + 5000 },
    });
    assert.strictEqual(res.json && res.json.success, true, `post-roll window rejected: ${res.body}`);
  });

  for (const [name, patchMeta] of [
    ['durationMs 与 actual 时间窗不符', (m) => ({ ...m, durationMs: 119000 })],
    ['声明 119s、文件实际 3s', (m) => ({ ...m, actualStartServerMs: m.actualEndServerMs - 119000, durationMs: 119000 })],
  ]) {
    await scenario(`媒体内容与 metadata 不符时应拒绝（${name}）`, async () => {
      const t = await createTask('u1');
      const p = (await b1.nextFor(t.taskId)).items[0];
      const media = await createUpload(t.taskId, p, WEBM, 'media');
      await uploadAll(media.uploadId, p.uploadToken, WEBM.buf);
      const res = await request('POST', `/api/clips/uploads/${media.uploadId}/complete`, {
        headers: uploader(p.uploadToken),
        json: { metadata: patchMeta(metadata(windowNow())) },
      });
      assert.strictEqual(res.json && res.json.success, false, 'mismatched metadata accepted');
    });
  }

  // 会重启 Hub、断开已连接的选手端，放在最后
  await scenario('[续传] Hub 进程被 kill -9 后重启，按持久化 offset 续传', async () => {
    const { w, token, uploadId } = await newMediaUpload(b1);
    await patch(uploadId, token, 0, WEBM.buf.subarray(0, 8192));
    partialPatch(uploadId, token, 8192, WEBM.buf.subarray(8192), 4000, 'stall');
    await sleep(300);
    hub.kill('SIGKILL');
    await once(hub, 'exit');
    hubLog = '';
    await startHub(rlApi.address().port);
    const off = await headOffset(uploadId, token);
    console.log(`      offset after restart = ${off}`);
    assert.strictEqual(off, 8192);
    await resumeAndComplete(uploadId, token, WEBM.buf, w);
  });
}

main()
  .catch((e) => console.error('smoke aborted:', e))
  .finally(async () => {
    if (hub && hub.exitCode === null) hub.kill('SIGTERM');
    rlApi.close();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (process.env.SHOW_HUB_LOG) console.log(hubLog);
    fs.rmSync(TMP, { recursive: true, force: true });
    setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
  });
