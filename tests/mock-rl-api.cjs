/* eslint-disable */
/**
 * 本地开发用的模拟 RL API，提供 Hub 用到的 getLiveContest / getContestMember，
 * 以及 KtO Arena 依赖的实时榜单 socket（/client 命名空间，只下发空的初始事件）。
 *
 * 用法：
 *   node tests/mock-rl-api.cjs
 *   RL_API_URL=http://127.0.0.1:3100/api pnpm run dev
 *   KtO 配置：apiBaseUrl=http://127.0.0.1:3100/api、socketIOUrl=http://127.0.0.1:3100、socketIOPath=/rankland_web/socket.io
 *
 * 可选环境变量：MOCK_RL_PORT（默认 3100）、MOCK_UCA（默认 contest-a）、
 * MOCK_USERS（逗号分隔 userId，默认 u1,u2）、MOCK_BROADCASTER_TOKEN（默认 test-broadcaster-token，所有选手共用）
 */
const http = require('http');
const { Server } = require('socket.io');

const port = Number(process.env.MOCK_RL_PORT) || 3100;
const uca = process.env.MOCK_UCA || 'contest-a';
const users = (process.env.MOCK_USERS || 'u1,u2').split(',');
const broadcasterToken = process.env.MOCK_BROADCASTER_TOKEN || 'test-broadcaster-token';
const startAt = new Date().toISOString();
const member = (id) => ({
  id,
  name: { 'zh-CN': `测试选手 ${id}`, fallback: `Tester ${id}` },
  organization: 'Local',
  location: 'Localhost',
  official: true,
  banned: false,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const alias = url.searchParams.get('alias');
  const userId = url.searchParams.get('userId');
  const send = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  // KtO 渲染进程跨域请求（线上 RL API 同样允许跨域）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    return res.end();
  }
  console.log(`${req.method} ${url.pathname} alias=${alias}${userId ? ` userId=${userId}` : ''}`);

  if (alias !== uca) {
    return send({ success: false, code: 100001 });
  }
  if (url.pathname.endsWith('/getLiveContest')) {
    return send({
      success: true,
      code: 0,
      data: {
        alias: uca,
        name: uca,
        contest: { title: { 'zh-CN': '精彩回放测试赛', fallback: 'Highlight Test' }, startAt, duration: [5, 'h'] },
        problems: [],
        markers: [],
        series: [],
        sorter: { algorithm: 'ICPC', config: {} },
        contributors: [],
        // KtO 从这里取选手列表
        members: users.map(member),
      },
    });
  }
  if (url.pathname.endsWith('/getContestMember') && users.includes(userId)) {
    return send({
      success: true,
      code: 0,
      data: { ...member(userId), broadcasterToken },
    });
  }
  send({ success: false, code: 100002 });
});

// KtO Arena 收到 InitClientEventsDone 后才渲染各面板
const io = new Server(server, { path: '/rankland_web/socket.io', cors: { origin: '*' } });
io.of('/client').on('connection', (socket) => {
  console.log(`socket /client connected alias=${socket.handshake.auth?.alias}`);
  // 空的 BatchClientEvent（protobuf 编码为 0 字节）
  socket.emit('InitClientEvents', Buffer.alloc(0));
  socket.emit('InitClientEventsDone');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock RL API: http://127.0.0.1:${port}/api`);
  console.log(`  live socket   : http://127.0.0.1:${port} (path /rankland_web/socket.io)`);
  console.log(`  contest alias : ${uca}`);
  console.log(`  users         : ${users.join(', ')}`);
  console.log(`  broadcaster token: ${broadcasterToken}`);
});
