# Closeout — 验证记录（T016）

日期：2026-11-02。环境：macOS arm64，Node v16.20.1，pnpm 8.15.9，typeorm 0.3.26，sqlite3 5.1.7，
ffmpeg/ffprobe 9.0.2，本地 Redis。基线提交 25207f6，改动未提交。

**证据级别：Hub 协议测试端模拟。** 测试启动真实 Hub 子进程（伪 RL API、临时存储），
用 socket.io-client 与 HTTP 扮演选手端和导播端；不代表真实 KtB/KtO 联调通过。

| 命令 | 结果 |
| --- | --- |
| `pnpm run test:clips` | exit 0，7/7 passed |
| `pnpm exec tsc -p src/server/tsconfig.json --noEmit` | exit 0 |
| `pnpm exec eslint`（新增与修改的 ts 文件） | exit 0 |
| `pnpm exec prettier --check`（新增文件与测试脚本） | 通过 |
| `pnpm run build` | exit 0 |
| `pnpm run db:migration:run` 后再 `migration:generate` | 提示 No changes，实体与表结构一致 |

## 验收标准对应

| 验收 | 用例 |
| --- | --- |
| SC-001 手动单 track 下发、上传、生成 ready 切片 | SC-001 用例（含缩略图、clipCreated 推送） |
| SC-002 离线 / track 不存在 / 录制范围缺失给出失败与错误码 | SC-002 用例（离线 3 次后 `target_offline`；ACK `track_not_found` 不重试）；多 track 用例（`recording_range_missing`） |
| SC-003 中断后 HEAD 取 offset 继续上传 | SC-003 用例（409 带真实 offset；SIGKILL 重启 Hub 后续传，最终 SHA-256 一致） |
| SC-004 校验失败不生成 ready 切片 | SC-004 用例（checksum 不符、时长不符） |
| SC-005 列表可见并可 Range 播放 | SC-005 用例（HEAD、完整读取、`a-b`、`-n`、越界 416、缩略图） |

另覆盖：多 track `partial_ready`、幂等创建、删除幂等且删除后不可读取、非导播凭证不能访问列表。

## 说明

- 导播鉴权失败沿用现有 `GuardNotPassExceptionHandler`，返回 HTTP 200 + `code:-4`（不返回内容），已写入契约。
- 未覆盖：真实 KtB/KtO 跨端联调、Linux 目标平台、清理定时任务的到期路径（到期依赖比赛结束 + 30 天，未做时间注入）。
