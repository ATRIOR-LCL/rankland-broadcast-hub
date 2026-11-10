# Implementation Plan: 精彩回放（手动首版）

**Branch**: `master` | **Date**: 2026-10-28，2026-11-01 精简修订 | **Spec**: [spec.md](spec.md)

## Summary

按 [设计文档](../../docs/v1/designs/highlight-replay.md) 实现手动精彩回放初版。
代码组织与 live-contest 一致：common DTO + controller + service，基础设施客户端放 `lib/`，
配置用 `@Config()`，Socket 命名空间写在 `socket-io.ts`，鉴权复用现有 `AuthGuard`。

## Technical Context

- **Language/Version**: TypeScript ~4.6.2，Node.js ^16，pnpm ^8（不变）
- **Dependencies**: 现有 bwcx、Koa、Socket.io、class-validator；新增 `typeorm@0.3.26`、`sqlite3@5.1.7`、`reflect-metadata@^0.2.2`（与 rankland-web 一致）；
  测试用 devDependency `socket.io-client`；系统 `ffprobe`
- **Storage**: SQLite（TypeORM 实体 + migration，四张表）+ 本地文件系统
- **Testing**: Node assert 脚本，启动真实 Hub 子进程 + 伪 RL API + 协议测试端
- **Constraints**: 单实例单 worker；最大时长 120s、单文件 500 MiB、token 15 分钟、最多 3 次尝试

## Constitution Check

| 原则 | 结论 |
| --- | --- |
| I 职责与范围 | PASS：只做手动回放，不预建自动化 |
| II 协议先行 | PASS：沿用 docs/v1 协议的手动部分；偏差记录在 contracts/ |
| III 一致性 | PASS：先落盘再确认 offset；校验通过才发布；每项至多一个 Clip |
| IV 隔离权限 | PASS：导播复用既有 `X-Token`/`directorToken` 体系；所有查询带 `uca`；upload token 仅限任务项 |
| V 最小改动 | PASS：复用既有分层和鉴权，不改推流逻辑 |

## Project Structure

```text
src/common/modules/clip/clip.dto.ts           # 请求/响应 DTO（@FromBody/@FromQuery/@FromParam + class-validator）
src/server/configs/clip/clip.config.ts        # @Config()，读取 CLIP_* 环境变量
src/server/configs/sqlite/sqlite.config.ts    # @Config()，sqlite 文件路径
src/server/database/typeorm-data-source.ts    # DataSource 选项（同 rankland-web）
src/server/database/typeorm-client.ts         # @Provide() TypeOrmClient，afterWire init、beforeExit destroy
src/server/database/typeorm-cli-data-source.ts # typeorm CLI 用
src/server/database/migrations/               # 由 db:migration:generate 生成并人工 review
src/server/entities/clip*.entity.ts           # 四个实体，一表一文件，snake_case 列名
src/server/modules/clip/clip.controller.ts    # 全部 /api/clips 路由
src/server/modules/clip/clip.service.ts       # 任务、下发重试、上传、校验发布、素材、清理
src/server/modules/socket-io/socket-io.ts     # 新增 requestCreateClip 下发与 /clips 命名空间（写法同 /shot）
src/server/exceptions/clip-http.exception.ts  # 原生路由错误（带 HTTP status 与可选 Upload-Offset）
src/server/exception-handlers/clip-http.exception-handler.ts
src/common/enums/err-code.enum.ts             # 增加 Clip 错误码（沿用协议 300000 段）
src/server/index.ts                           # afterWire 初始化 TypeOrmClient；Socket 初始化后启动回放定时任务
tests/highlight-replay.test.cjs       # 验收测试
```

## Design Decisions

- **数据库**：照 rankland-web 的写法：`TypeOrmClient` 持有 typeorm 0.3 `DataSource`，service 通过
  `this.dataSource.getRepository(Entity)` 访问，不手写业务 SQL。`synchronize: false`，表结构由 migration 管理：
  `pnpm run db:migration:generate src/server/database/migrations/<Name>` 生成、人工 review 后提交，
  部署前 `pnpm run db:migration:run`。typeorm 的 sqlite 驱动全连接共用一个 queryRunner，并发事务会交错（已用实验复现：
  B 报告提交成功、却随 A 回滚丢失）。因此 service 中**所有写操作**都经同一个队列串行执行，每个写操作是一个
  `dataSource.transaction()`；队列内只做数据库读写，不做文件或网络 IO。读操作不排队。
  选 SQLite 而非 MySQL：媒体本就在本地磁盘、Hub 只能单实例，数据库与媒体同目录便于备份迁移，零运维且负载很小。
- **部署**：Dockerfile 启动前执行 `db:migration:run`；compose 需持久化挂载 `/app/data`。
- **JSON 接口**：`@Contract(ReqDTO, RespDTO)` + `@Data()`，DTO 只做字段校验，
  时间窗等业务校验在 Controller；错误用 `LogicException`，沿用现有 `Resp` 包装。
- **导播鉴权**：`@UseGuards(AuthGuard)`，比赛由 `X-UCA` 请求头指定。
- **选手鉴权**：`X-UCA` + `X-Upload-Token`；token 随下发生成，只保存 SHA-256；
  绑定 (uca, taskId, itemId, generation)，重试换新 generation 和 token，旧 token 失效。
- **原生接口**：上传 HEAD/PATCH、媒体 HEAD/GET、缩略图 GET 也是 controller 路由，
  用现有 `@CustomResponse()` 原样返回；PATCH 从 `ctx.req` 流式读取（bodyparser 不解析
  `application/offset+octet-stream`）；错误抛 `ClipHttpException`，由其处理器设置状态码与空正文。
- **断点续传**：同一 uploadId 的 PATCH 在进程内串行；写入并 fsync 后再更新 offset；
  失败或中断时截断回已确认 offset。启动时把接收中的临时文件截断到已确认 offset。
- **校验发布**：complete 时持久化元数据与预分配 clipId，任务项进入 verifying；
  后台按队列逐个执行 SHA-256 + ffprobe 校验，通过后把文件移到 `clips/{clipId}/` 并写入 `clips`，
  再推送事件。启动时对仍为 verifying 的项重新校验（临时文件不在而正式文件在时校验正式文件）。
- **下发与重试**：service 内 1 秒轮询 `queued` 项；按任务合并下发，ACK 超时 10 秒；
  可重试失败 5 秒后重试，尝试耗尽为 `failed`。token 到期仍未完成按可重试处理。
- **清理**：60 秒轮询，ready 过期置 expired；deleted/expired 的文件删除；过期未完成上传删除临时文件。
- **配额**：已发布未清理文件 + 活动上传声明长度，创建上传时检查。

## Known Constraints

- 单 worker：推流房间本就在进程内存，回放与之相同；多 worker 不支持。
- 不做跨进程锁、孤儿文件扫描和逐崩溃边界恢复；极端崩溃下可能残留临时文件，需人工清理。
