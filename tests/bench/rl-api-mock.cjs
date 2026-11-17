/* eslint-disable */
/**
 * 测试 Hub 用的 RL API mock：任意比赛 uk 都存在，选手 u001–u100，broadcasterToken 为 bt-<userId>。
 * 用法：node rl-api-mock.cjs [port]，Hub 设置 RL_API_URL=http://127.0.0.1:<port>/api/v2
 */
const http = require('http');

const port = +(process.argv[2] || 3100);
const USERS = new Set(Array.from({ length: 100 }, (_, i) => `u${String(i + 1).padStart(3, '0')}`));

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let m = url.pathname.match(/^\/api\/v2\/public\/contests\/([^/]+)$/);
    if (m) {
      return send({ success: true, code: 0, data: { uk: m[1], title: m[1], startAt: new Date().toISOString(), duration: [5, 'h'] } });
    }
    m = url.pathname.match(/^\/api\/v2\/contests\/([^/]+)\/users\/([^/]+)$/);
    if (m && USERS.has(m[2])) {
      return send({ success: true, code: 0, data: { id: m[2], name: m[2], banned: false, broadcasterToken: `bt-${m[2]}` } });
    }
    send({ success: false, code: 100002 });
  })
  .listen(port, '127.0.0.1', () => console.log(`rl api mock listening on ${port}`));
