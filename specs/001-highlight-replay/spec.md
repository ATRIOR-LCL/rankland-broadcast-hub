# Feature Specification: 精彩回放（手动首版）

**Feature Branch**: `master`（未创建或切换分支）

**Created**: 2026-10-28　**Revised**: 2026-11-01

**Status**: Draft

**Input**: 实现 [设计文档](../../docs/v1/designs/highlight-replay.md) 中的手动精彩回放初版；
接口以 [接口协议](../../docs/v1/protocols/highlight-replay.md) 的手动部分为准。

## 范围修订（2026-11-01）

用户确认：本版只需实现设计文档的手动精彩回放初版，代码组织与既有 live-contest 模块一致，
避免过度设计。相比 2026-10-28 版本删除了以下要求：按比赛授权文件、发布阶段逐边界崩溃恢复、
独占进程锁、孤儿文件扫描、故障注入、前缀 hash 对账、旧代 token 历史、本地 IO 多次重试、
分阶段 deadline、清理指数退避和回放专用 CORS。

自动化配置、运行记录、agent 接口与触发器仍不在本版范围。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 手动取片并播放 (Priority: P1)

导播指定比赛、选手、一个或多个 track、时间窗及标题分类，创建取片任务；Hub 通知选手端上传，
校验通过后导播可以检索、订阅并按 Range 播放片段。

**Independent Test**: 使用协议测试端模拟选手端完成单 track 取片，导播列表可见并能 Range 读取。

**Acceptance Scenarios**:

1. **Given** 选手在线且录像覆盖时间窗，**When** 导播创建单 track 任务，
   **Then** 选手收到 `requestCreateClip`，上传后 Hub 生成 `ready` 切片。
2. **Given** 多 track 任务中一路成功、一路返回 `recording_range_missing`，
   **When** 所有项结束，**Then** 成功项可播放，任务为 `partial_ready`。
3. **Given** 同一幂等标识的重复创建，**Then** 返回同一任务。
4. **Given** 切片已就绪，**When** 导播按条件列表查询或订阅，**Then** 能看到切片并用 HTTP Range 播放。

### User Story 2 - 断点续传与校验 (Priority: P1)

选手端上传中断或 Hub 重启后，通过 HEAD 查询已确认 offset 继续上传；内容不合格不生成切片。

**Acceptance Scenarios**:

1. **Given** 部分内容已确认，**When** 上传中断（含 Hub 重启），**Then** HEAD 返回已确认 offset，
   从该处继续上传后最终文件与原文件一致。
2. **Given** PATCH 的 offset 与服务端不一致，**Then** 返回 409 和当前 offset，不覆盖已确认内容。
3. **Given** checksum、容器或时长不符，**When** 提交 complete，**Then** 不生成 `ready` 切片，任务项给出错误码。

### User Story 3 - 失败、删除与保留 (Priority: P2)

**Acceptance Scenarios**:

1. **Given** 选手离线，**Then** Hub 有限重试，耗尽后任务失败并显示尝试次数和 `target_offline`。
2. **Given** track 不存在或录制范围缺失，**Then** 对应项不可重试失败并显示错误码。
3. **Given** 导播删除切片或切片过期，**Then** 默认列表不再返回、媒体不可读取，文件被异步清理。

### Edge Cases

- 时间窗非法（结束不大于开始、结束晚于当前、超过最大时长）、track 为空或重复：拒绝创建。
- 上传超过声明长度或文件大小上限、upload token 过期或不属于该任务项：拒绝。
- 无音频的合法视频：正常通过。
- 越界或多段 Range：416。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 导播（沿用现有 `X-Token` 鉴权）可创建手动 `ClipTask`，按 track 拆分 `ClipTaskItem`，
  支持 `idempotencyKey`，并能列表、筛选、分页和查看详情。
- **FR-002**: Hub 通过 `/broadcaster` Socket.io 向目标选手下发 `requestCreateClip`，
  携带每个任务项的短期 upload token 和 generation。
- **FR-003**: 离线、下发超时、token 到期为可重试错误，默认最多 3 次；
  `track_not_found`、`recording_range_missing`、`invalid_time_window`、`media_validation_failed`、
  `upload_checksum_mismatch` 不重试。成功项不重派发。
- **FR-004**: 任务与任务项状态、进度、尝试次数、错误码按设计文档状态机维护；
  全部项成功为 `ready`，部分成功为 `partial_ready`，全部失败为 `failed`。
- **FR-005**: upload token 只允许本任务项的进度上报和上传会话操作，不能访问列表或媒体。
- **FR-006**: 上传使用 TUS 风格 offset 语义：创建会话、HEAD 查询、PATCH 追加、complete 提交元数据。
  写入落盘后才确认 offset；Hub 重启后已确认内容可继续上传。
- **FR-007**: complete 后 Hub 校验大小、SHA-256、容器、编码、时长及实际时间窗覆盖，
  通过后才生成 `Clip` 并通知 `clipCreated`；每个任务项至多一个 `Clip`。
- **FR-008**: 提供切片列表、缩略图、媒体 HEAD/GET（单段 Range、206、416）和软删除。
- **FR-009**: `/clips` Socket.io 命名空间推送 `clipTaskUpdated`、`clipCreated`、`clipDeleted`，可按分类/选手订阅。
- **FR-010**: 切片默认保留至比赛结束后 30 天（无法获取时从创建时间起算），删除与过期的文件定时清理。
- **FR-011**: 限制单文件大小、切片最大时长、单任务 track 数量和总存储配额。
- **FR-012**: 所有记录带 `uca`，查询按比赛隔离；媒体路径只从数据库登记的记录解析。

### Key Entities

`ClipTask`、`ClipTaskItem`、`ClipUpload`、`Clip`，字段见 [data-model.md](data-model.md)。

## Success Criteria *(mandatory)*

即设计文档验收标准：

- **SC-001**: 手动创建单 track 任务后，选手端收到 `requestCreateClip` 并上传，Hub 生成 `ready` 切片。
- **SC-002**: 选手离线、track 不存在、录制范围缺失时，任务给出明确失败状态和错误码。
- **SC-003**: 上传中断后，选手端能通过 HEAD 获取 offset 并继续上传。
- **SC-004**: 校验失败时不生成 `ready` 切片。
- **SC-005**: 导播能通过列表接口看到切片，并通过 HTTP Range 播放媒体。

## Assumptions

- 单 Hub 实例、单 worker 运行（与现有内存态推流房间的约束一致），SQLite + 本地文件系统。
- 部署环境安装 ffprobe；缺失时校验失败，不发布切片。
- 本期只用协议测试端验证 Hub，真实 KtB/KtO 联调另行进行。
