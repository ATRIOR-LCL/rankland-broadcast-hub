# Research: 精彩回放（手动首版）

2026-11-01 精简修订，只保留影响实现的结论。

## R1 — SQLite 驱动

**Decision**: 用户要求通过 ORM 接入并参照 rankland-web：typeorm `0.3.26` + `sqlite3@5.1.7`，
`TypeOrmClient`（`@Provide()`）包装 `DataSource`，实体放 `src/server/entities/`，migration 管理表结构。
曾尝试 bwcx-plugin-typeorm，但 rankland-web 未使用该插件，且插件只支持 typeorm 0.2 API，已放弃。
typeorm 0.3.26 要求 Node `>=16.13`，本机 Node 16.20.1 验证：migration 生成/执行、生成后无结构漂移、Hub 启动均通过。
需要直接依赖 `reflect-metadata@^0.2.2`（与 rankland-web 相同），否则 pnpm 严格模式下 CLI 加载失败。

**约束**: sqlite 驱动单连接共用一个 queryRunner，并发事务会变成交错的 SAVEPOINT；`Repository.save` 默认也开事务。
写入用 `insert`/`update`，需要原子性的两处在互斥锁内开事务。peer 警告 `ioredis` 来自 typeorm 可选缓存，未使用。

## R2 — 原生 HTTP 接口

**Decision**: 上传 HEAD/PATCH、媒体与缩略图读取写成普通 bwcx 路由，配合现有 `@CustomResponse()`
原样返回。bwcx 默认 bodyparser 只解析 JSON/form，`application/offset+octet-stream` 的请求体
保留在 `ctx.req`，可流式写盘；GET 返回文件读流，由 Koa 按背压输出。

## R3 — 鉴权

**Decision**: 按设计文档沿用现有 `X-Token`/`directorToken`（`AuthGuard`）。选手上传使用下发时生成的
随机 token，只保存 hash，绑定任务项与 generation。

## R4 — 下发

**Decision**: 选手 `/broadcaster` 连接建立时加入 `clip:{uca}:{userId}` 房间；Hub 用
`timeout(10s).emit('requestCreateClip')` 下发并收集 ACK，房间为空视为离线。

## R5 — 媒体校验

**Decision**: 系统 ffprobe（`execFile`，无 shell，超时 60 秒）读取容器/编码/时长/尺寸；SHA-256 流式计算。
不转码。
