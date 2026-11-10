# Quickstart: 精彩回放验证

## 前置

- Node.js 16、pnpm 8、本地 Redis（Hub 启动依赖）、ffprobe/ffmpeg（测试媒体由 ffmpeg 生成）。

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run db:migration:run   # 建表；运行时不会自动执行 migration
pnpm run test:clips
```

`test:clips` 会构建后启动真实 Hub 子进程（伪 RL API、临时存储目录），用协议测试端覆盖
设计文档的 5 条验收标准及断点续传、Range、删除等关键行为。

## 手动核查

```sh
export AUTH_TOKEN=...            # 导播 token
export CLIP_STORAGE_DIR=/tmp/clips
pnpm run dev
curl -H "X-UCA: $UCA" -H "X-Token: $AUTH_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @create-clip-task.json http://127.0.0.1:3001/api/clips/tasks
curl -H "X-UCA: $UCA" -H "X-Token: $AUTH_TOKEN" http://127.0.0.1:3001/api/clips
```

## 证据级别

本期只有 Hub 协议测试端的模拟结果；真实 KtB/KtO 联调另行验收。
