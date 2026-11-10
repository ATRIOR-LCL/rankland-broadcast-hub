---
description: "手动精彩回放初版的 Hub 实现任务（2026-11-01 精简修订）"
---

# Tasks: 精彩回放（手动首版）

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[data-model.md](data-model.md)、[契约](contracts/highlight-replay.md)

**Scope**: 只实现设计文档的手动精彩回放初版，代码组织对齐 live-contest；不做自动化。

**Tests**: 一个基于真实 Hub 子进程的验收脚本，覆盖 SC-001–SC-005 及关键协议行为。

## Format: [ID] [P?] [Story] Description

## Phase 1: Setup

- [X] T001 在 package.json、pnpm-lock.yaml 增加 `typeorm@0.3.26`、`sqlite3@5.1.7`、`reflect-metadata@^0.2.2`（与 rankland-web 一致），devDependency `socket.io-client`；增加 `db:migration:generate`/`db:migration:run` 脚本
- [X] T002 在 src/server/configs/clip/clip.config.ts 新增 `@Config()` ClipConfig，读取契约中的 CLIP_* 配置
- [X] T003 照 rankland-web：src/server/configs/sqlite/sqlite.config.ts、src/server/database/（data source、TypeOrmClient、CLI data source、首个 migration）、src/server/entities/ 四个实体；src/server/index.ts afterWire 初始化、beforeExit 销毁
- [X] T004 在 src/common/enums/err-code.enum.ts、src/server/err-code-configs/general.err-code.ts 增加 Clip 错误码；新增 src/server/exceptions/clip-http.exception.ts 与对应 exception handler（原生接口：状态码 + 空正文 + X-Clip-Error-Code）

## Phase 2: User Story 1 - 手动取片并播放 (P1)

- [X] T005 [US1] 在 src/common/modules/clip/clip.dto.ts 定义枚举、实体类型与全部请求/响应 DTO
- [X] T006 [US1] 在 src/server/modules/socket-io/socket-io.ts 增加：选手连接加入 `clip:{uca}:{userId}` 房间、`requestCreateClip(uca, userId, payload)` 带 ACK 超时下发、`/clips` 命名空间（directorToken 校验、subscribeClips、按过滤器推送）
- [X] T007 [US1] 在 src/server/modules/clip/clip.service.ts 实现任务创建（幂等、选手校验、保留期）、查询与状态/进度聚合
- [X] T008 [US1] 在 clip.service.ts 实现下发轮询：按任务合并 queued 项，换代生成 token，处理 ACK/离线/超时与重试、token 到期
- [X] T009 [US1] 在 clip.service.ts 实现进度上报、上传创建（同声明复用、配额）、HEAD、PATCH 流式追加（串行、落盘后确认、失败截断）
- [X] T010 [US1] 在 clip.service.ts 实现 complete、SHA-256 + ffprobe 校验队列与发布（移动文件、写 clips、推送事件）
- [X] T011 [US1] 在 clip.service.ts 实现素材列表、媒体/缩略图读取（单段 Range）
- [X] T012 [US1] 在 src/server/modules/clip/clip.controller.ts 实现全部路由：导播接口 `@UseGuards(AuthGuard)`，JSON 接口 `@Contract` + `@Data`，原生接口 `@CustomResponse()`
- [X] T013 [US1] 在 src/server/index.ts 中 Socket 初始化后启动回放定时任务、启动恢复（截断接收中临时文件、重新校验 verifying 项）

## Phase 3: User Story 2/3 - 删除、保留与清理 (P1/P2)

- [X] T014 [US3] 在 clip.service.ts、clip.controller.ts 实现软删除、到期处理、文件清理定时任务，推送 clipDeleted

## Phase 4: 验证与文档

- [X] T015 在 tests/highlight-replay.test.cjs 编写验收脚本（真实 Hub 子进程 + 伪 RL API + 协议测试端），覆盖 SC-001–SC-005、多 track partial_ready、幂等、offset 冲突、Hub 重启后续传、Range/416、删除；package.json 增加 `test:clips`
- [X] T016 运行 `pnpm run test:clips`、`tsc --noEmit`、eslint/prettier、`pnpm run build`，结果记录到 specs/001-highlight-replay/closeout/validation.md
- [X] T017 同步 docs/v1/designs/highlight-replay.md 与 docs/v1/protocols/highlight-replay.md 中“首版补充”章节，删除已废弃的按比赛授权等描述，指向本精简契约

## Dependencies

T001 → T002–T004 → T005 → T006–T011（T007→T008→T009→T010→T011 同文件串行）→ T012 → T013 → T014 → T015 → T016 → T017

## Requirement Coverage

| 需求 | 任务 |
| --- | --- |
| FR-001 创建/查询/幂等 | T005、T007、T012 |
| FR-002 下发 | T006、T008 |
| FR-003 重试 | T008 |
| FR-004 状态聚合 | T007 |
| FR-005 upload token | T008、T009 |
| FR-006 断点续传 | T009、T013 |
| FR-007 校验发布 | T010、T013 |
| FR-008 列表/媒体/删除 | T011、T014 |
| FR-009 订阅推送 | T006 |
| FR-010 保留清理 | T007、T014 |
| FR-011 限额 | T002、T005、T009、T012 |
| FR-012 比赛隔离 | 全部查询带 uca；T015 验证 |
| SC-001–SC-005 | T015 |
