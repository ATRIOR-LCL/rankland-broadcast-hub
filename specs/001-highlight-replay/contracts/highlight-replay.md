# Highlight Replay Contract — 手动首版

接口以 [接口协议](../../../docs/v1/protocols/highlight-replay.md) 为准（不含自动化章节）。本文件只列补充与偏差。

## 鉴权

- 导播接口：`X-UCA` + `X-Token`，复用现有 `AuthGuard`（全局 `AUTH_TOKEN`）。
  协议中列表 query 的 `uca` 改为统一从 `X-UCA` 读取。
- `/clips` 命名空间：`query.uca` + `auth.directorToken`，校验方式与 `/shot` 相同。
- 选手接口：`X-UCA` + `X-Upload-Token`。token 绑定 (uca, taskId, itemId, generation)，
  过期或旧代 token 拒绝；不能访问列表、详情和媒体。

## 错误

- JSON 接口沿用 `Resp` 包装与现有异常处理（`LogicException`，参数校验 `ValidationException`）。
- 原生接口（上传 HEAD/PATCH、媒体 HEAD/GET、缩略图 GET）无 JSON 正文：
  404 不存在、401 凭证无效、410 会话/凭证过期、409 offset 不一致（带 `Upload-Offset`）、
  413 超出声明长度或上限、416 Range 不可满足（带 `Content-Range: bytes */size`），并带 `X-Clip-Error-Code`。
- 导播鉴权失败（含媒体/缩略图读取）沿用现有 `GuardNotPassExceptionHandler`：HTTP 200 + `{success:false, code:-4}`，不返回内容。

新增业务码（沿用协议建议的 300000 段）：

| 码 | 含义 |
| --- | --- |
| 300010 | ClipTaskNotFound |
| 300011 | ClipTaskInvalidTimeWindow |
| 300020 | ClipUploadNotFound |
| 300021 | ClipUploadOffsetMismatch |
| 300023 | ClipUploadExpired（含 token 无效/过期） |
| 300024 | ClipUploadConflict（同代同角色声明不同） |
| 300025 | ClipUploadInvalidState |
| 300026 | ClipStorageQuotaExceeded |
| 300030 | ClipMediaValidationFailed |
| 300040 | ClipNotFound |
| 300041 | ClipMediaRangeNotSatisfiable |

## 行为补充

- 创建任务：`source` 只接受 `manual`；时间窗须已结束、`end > start`、长度不超过 `CLIP_MAX_DURATION_MS`；
  track 1–16 个且不重复。同 `idempotencyKey` 返回已有任务。
- `requestCreateClip` 只发给该比赛该选手的 `/broadcaster` 选手连接；ACK `accepted:false` 时按 `errorCode` 判断是否重试。
- 进度上报 `status` 只能是 `client_processing`/`uploading`/`failed`；进度不回退。
- 上传创建：同代同角色已有活动会话且声明相同时返回原会话和当前 offset，声明不同报错。
- complete 只对 `media` 会话；可引用同任务项同代、已传满的缩略图会话。接受后返回 task（verifying），
  校验结果通过 `clipTaskUpdated`/`clipCreated` 推送或查询获得；重复 complete 返回当前结果。
- 校验：大小、SHA-256；MP4 需 H.264（音频若有为 AAC），WebM 需 VP8/VP9（音频若有为 Opus）；
  声明时长与实测差 ≤ 1000ms；实际时间窗覆盖请求时间窗。
- 媒体读取：仅 `ready` 且未过期；支持完整读取和单段 Range（`a-b`、`a-`、`-n`），多段与越界 416。
- `subscribeClips`：`categories`/`userIds` 省略不过滤，两者同时给出取交集；新订阅替换旧订阅。

## 配置

| 变量 | 默认 |
| --- | --- |
| CLIP_STORAGE_DIR | `./data/highlight-replay` |
| CLIP_SQLITE_PATH | `{CLIP_STORAGE_DIR}/clips.sqlite` |
| CLIP_MAX_DURATION_MS | 120000 |
| CLIP_MAX_UPLOAD_BYTES | 524288000 |
| CLIP_MAX_STORAGE_BYTES | 21474836480 |
| CLIP_DEFAULT_RETENTION_DAYS | 30 |
| CLIP_UPLOAD_TOKEN_TTL_MS | 900000 |
| CLIP_TASK_MAX_ATTEMPTS | 3 |
| CLIP_FFPROBE_PATH | `ffprobe` |
