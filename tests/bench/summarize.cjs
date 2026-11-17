/* eslint-disable */
/**
 * 把 stress.cjs 的 JSONL 汇总成 Markdown 表格：每个用例目录一行，多次运行取中位数。
 * 用法：node summarize.cjs outputs/stress [用例目录前缀...]
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || path.join(__dirname, 'outputs/stress');
const prefixes = process.argv.slice(3);

const median = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const fmt = (x, d = 2) => (x === null || x === undefined ? '-' : +x.toFixed(d));

function loadRuns(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      return { file: f, summary: lines.find((l) => l.type === 'summary'), secs: lines.filter((l) => l.type === 'sec') };
    })
    .filter((r) => r.summary && r.summary.stream);
}

const rows = [];
for (const name of fs.readdirSync(root).sort()) {
  const dir = path.join(root, name);
  if (!fs.statSync(dir).isDirectory() || (prefixes.length && !prefixes.some((p) => name.startsWith(p)))) continue;
  const runs = loadRuns(dir);
  if (!runs.length) continue;
  const per = runs.map(({ summary: s }) => {
    const ph = s.stream.phases || {};
    const main = ph.upload || ph.pre || {};
    const pre = ph.pre || {};
    const u = s.uploads || {};
    return {
      loss: main.lossPct,
      frameOk: main.frameOkPct,
      keyOk: main.keyOkPct,
      p50: main.rtt && main.rtt.p50,
      p95: main.rtt && main.rtt.p95,
      p99: main.rtt && main.rtt.p99,
      max: main.rtt && main.rtt.max,
      dp95: main.rtt && pre.rtt && main !== pre ? main.rtt.p95 - pre.rtt.p95 : null,
      postLoss: ph.post ? ph.post.lossPct : null,
      upMbps: median(u.mbps || []),
      upSec: median((u.uploadMs || []).map((x) => x / 1000)),
      maxUpSec: u.uploadMs && u.uploadMs.length ? Math.max(...u.uploadMs) / 1000 : null,
      chunkP95: u.chunkMs && u.chunkMs.p95,
      completeMs: median(u.completeMs || []),
      ok: u.ok,
      expected: u.expected,
      c409: u.c409,
      retries: u.retries,
      drops: s.tc && (s.tc.upload || s.tc.pre) ? (s.tc.upload || s.tc.pre).drops : null,
      rss: s.proc && s.proc.maxRssMB,
    };
  });
  const m = (k) => median(per.map((p) => p[k]));
  const c = runs[0].summary.config;
  rows.push({
    name,
    runs: runs.length,
    cfg: `${c.streams}×${c.mbps}M ${c.mode === 'upload' ? `${c.players}p ${c.chunk >= 1048576 ? c.chunk / 1048576 + 'M' : c.chunk / 1024 + 'K'} ${c.pacing} ${c.limitMbps ? c.limitMbps + 'Mbps' : 'nolimit'}` : c.mode} tc=${c.tc || '-'}`,
    ...Object.fromEntries(Object.keys(per[0]).map((k) => [k, m(k)])),
    okAll: per.reduce((a, p) => a + (p.ok || 0), 0),
    expAll: per.reduce((a, p) => a + (p.expected || 0), 0),
  });
}

const cols = [
  ['用例', (r) => r.name],
  ['次数', (r) => r.runs],
  ['配置', (r) => r.cfg],
  ['推流丢包%', (r) => fmt(r.loss, 3)],
  ['帧完整%', (r) => fmt(r.frameOk, 2)],
  ['关键帧完整%', (r) => fmt(r.keyOk, 1)],
  ['RTT p50', (r) => fmt(r.p50, 1)],
  ['RTT p95', (r) => fmt(r.p95, 1)],
  ['Δp95', (r) => fmt(r.dp95, 1)],
  ['RTT p99', (r) => fmt(r.p99, 1)],
  ['上传 Mbps', (r) => fmt(r.upMbps, 1)],
  ['上传 s', (r) => fmt(r.upSec, 1)],
  ['块 p95 ms', (r) => fmt(r.chunkP95, 0)],
  ['complete ms', (r) => fmt(r.completeMs, 0)],
  ['成功', (r) => (r.expAll ? `${r.okAll}/${r.expAll}` : '-')],
  ['409/重试', (r) => `${fmt(r.c409, 0)}/${fmt(r.retries, 0)}`],
  ['tc 丢包', (r) => fmt(r.drops, 0)],
];
console.log(`| ${cols.map((c) => c[0]).join(' | ')} |`);
console.log(`|${cols.map(() => '---').join('|')}|`);
for (const r of rows) console.log(`| ${cols.map((c) => c[1](r)).join(' | ')} |`);
