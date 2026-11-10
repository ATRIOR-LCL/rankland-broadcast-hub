import path from 'path';
import { Config } from 'bwcx-ljsm';

function envInt(name: string, defaultValue: number) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : defaultValue;
}

@Config()
export default class ClipConfig {
  public readonly storageDir: string = path.resolve(process.env.CLIP_STORAGE_DIR || './data/highlight-replay');
  public readonly maxDurationMs: number = envInt('CLIP_MAX_DURATION_MS', 120000);
  public readonly maxUploadBytes: number = envInt('CLIP_MAX_UPLOAD_BYTES', 500 * 1024 * 1024);
  public readonly maxThumbnailBytes: number = 5 * 1024 * 1024;
  public readonly maxStorageBytes: number = envInt('CLIP_MAX_STORAGE_BYTES', 20 * 1024 * 1024 * 1024);
  public readonly retentionDays: number = envInt('CLIP_DEFAULT_RETENTION_DAYS', 30);
  public readonly uploadTokenTtlMs: number = envInt('CLIP_UPLOAD_TOKEN_TTL_MS', 15 * 60 * 1000);
  public readonly taskMaxAttempts: number = envInt('CLIP_TASK_MAX_ATTEMPTS', 3);
  public readonly ffprobePath: string = process.env.CLIP_FFPROBE_PATH || 'ffprobe';
  /** 下发 ACK 超时 */
  public readonly ackTimeoutMs: number = 10000;
  /** 可重试失败后等待下一轮的时间 */
  public readonly retryDelayMs: number = envInt('CLIP_RETRY_DELAY_MS', 5000);
  /** ffprobe 单次超时 */
  public readonly verifyTimeoutMs: number = 60000;
}
