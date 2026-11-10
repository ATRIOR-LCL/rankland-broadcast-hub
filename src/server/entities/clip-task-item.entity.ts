import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ClipTaskItemStatus } from '@common/modules/clip/clip.dto';

@Entity('clip_task_item')
@Index('IDX_clip_task_item_task_track', ['taskId', 'trackId'], { unique: true })
@Index('IDX_clip_task_item_schedule', ['status', 'nextAttemptAt'])
export class ClipTaskItemEntity {
  @PrimaryColumn({ name: 'item_id', type: 'varchar', length: 36 })
  public itemId: string;

  @Column({ type: 'varchar', length: 128 })
  public uca: string;

  @Column({ name: 'task_id', type: 'varchar', length: 36 })
  public taskId: string;

  @Column({ name: 'user_id', type: 'varchar', length: 128 })
  public userId: string;

  @Column({ name: 'track_id', type: 'varchar', length: 128 })
  public trackId: string;

  @Column({ type: 'varchar', length: 32 })
  public status: ClipTaskItemStatus;

  @Column({ type: 'real', default: 0 })
  public progress: number;

  @Column({ name: 'error_code', type: 'varchar', length: 64, nullable: true })
  public errorCode: string | null;

  @Column({ name: 'error_message', type: 'varchar', length: 500, nullable: true })
  public errorMessage: string | null;

  /** 已下发轮次 */
  @Column({ type: 'integer', default: 0 })
  public attempts: number;

  /** 每轮下发 +1，旧代 token 失效 */
  @Column({ type: 'integer', default: 0 })
  public generation: number;

  /** 当前代 upload token 的 SHA-256 */
  @Column({ name: 'token_hash', type: 'varchar', length: 64, nullable: true })
  public tokenHash: string | null;

  @Column({ name: 'token_expires_at', type: 'integer', nullable: true })
  public tokenExpiresAt: number | null;

  @Column({ name: 'next_attempt_at', type: 'integer', nullable: true })
  public nextAttemptAt: number | null;

  @Column({ name: 'actual_start_server_ms', type: 'integer', nullable: true })
  public actualStartServerMs: number | null;

  @Column({ name: 'actual_end_server_ms', type: 'integer', nullable: true })
  public actualEndServerMs: number | null;

  @Column({ name: 'created_at', type: 'integer' })
  public createdAt: number;

  @Column({ name: 'updated_at', type: 'integer' })
  public updatedAt: number;
}
