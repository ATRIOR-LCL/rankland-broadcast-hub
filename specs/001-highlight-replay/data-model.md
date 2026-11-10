# Data Model: 精彩回放（手动首版）

SQLite 四张表（`clip_task`、`clip_task_item`、`clip_upload`、`clip`），由 `src/server/entities/` 下的 TypeORM 实体定义，
建表与变更走 `src/server/database/migrations/`。列名为 snake_case，实体属性为 camelCase。均带 `uca`；ID 为服务端生成的 UUID；时间为毫秒时间戳。
`tags`、`complete_payload` 用 `simple-json` 保存。所有查询都带 `uca` 条件。

## clip_task

| 字段 | 说明 |
| --- | --- |
| task_id (PK) | |
| uca, user_id | 比赛与目标选手 |
| source | 本版固定 `manual` |
| title, category, tags, priority | 导播输入 |
| start_server_ms, end_server_ms | 请求时间窗 |
| status, progress | 由任务项聚合 |
| max_attempts | 默认 3 |
| error_code, error_message | 聚合后第一个失败项的错误 |
| idempotency_key | `(uca, idempotency_key)` 非空时唯一 |
| expires_at | 比赛结束 + 30 天，无法获取则创建时间 + 30 天 |
| created_at, updated_at | |

## clip_task_item

| 字段 | 说明 |
| --- | --- |
| item_id (PK) | |
| uca, task_id, user_id, track_id | `(task_id, track_id)` 唯一 |
| status, progress, error_code, error_message | |
| attempts | 已下发轮次 |
| generation | 每轮 +1；旧代 token 失效 |
| token_hash, token_expires_at | 当前代 upload token 的 SHA-256 与到期时间 |
| next_attempt_at | queued 时下一次下发时间 |
| actual_start_server_ms, actual_end_server_ms | 校验通过后写入 |
| created_at, updated_at | |

## clip_upload

| 字段 | 说明 |
| --- | --- |
| upload_id (PK) | |
| uca, task_id, item_id, generation | |
| role | `media` / `thumbnail` |
| status | `created`/`uploading`/`completed`/`failed`/`expired` |
| file_name, mime_type, upload_length, checksum_sha256 | 创建时声明 |
| upload_offset | 已落盘确认的字节数（offset 为 SQL 关键字） |
| complete_payload | complete 提交的元数据 JSON |
| clip_id | complete 时预分配的 clipId |
| expires_at | 等于该代 token 到期时间 |
| created_at, updated_at | |

## clip

| 字段 | 说明 |
| --- | --- |
| clip_id (PK) | |
| uca, task_id, item_id, user_id, track_id | `item_id` 唯一：每项至多一个 Clip |
| source, category, title, tags | 来自任务 |
| media_path, thumbnail_path | 相对存储根的路径 |
| mime_type, byte_size, duration_ms, width, height, video_codec, audio_codec, checksum_sha256 | 校验所得 |
| actual_start_server_ms, actual_end_server_ms | |
| status | `ready`/`deleted`/`expired` |
| files_removed | 文件已清理 |
| expires_at, created_at, deleted_at | |

## 状态

任务项：`queued → requested → client_processing → uploading → verifying → ready`，任一阶段可 `failed`；
可重试失败回到 `queued` 并设置 `next_attempt_at`。任务状态：有活动项时取最早阶段；
否则全 ready 为 `ready`，部分 ready 为 `partial_ready`，否则 `failed`；产物全部过期为 `expired`。
进度：各项进度平均，结束项（ready/failed）计 100。

## 文件布局

```text
{CLIP_STORAGE_DIR}/
  clips.sqlite                       # CLIP_SQLITE_PATH 默认值
  {encodeURIComponent(uca)}/
    uploads/{uploadId}.part
    clips/{clipId}/media.{mp4|webm}
    clips/{clipId}/thumbnail.{webp|jpg|png}
```
