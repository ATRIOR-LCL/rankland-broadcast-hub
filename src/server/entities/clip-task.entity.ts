import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ClipCategory, ClipPriority, ClipSource, ClipTaskStatus } from '@common/modules/clip/clip.dto';

@Entity('clip_task')
@Index('IDX_clip_task_uca_created', ['uca', 'createdAt'])
@Index('IDX_clip_task_idempotency', ['uca', 'idempotencyKey'], {
  unique: true,
  where: 'idempotency_key IS NOT NULL',
})
export class ClipTaskEntity {
  @PrimaryColumn({ name: 'task_id', type: 'varchar', length: 36 })
  public taskId: string;

  @Column({ type: 'varchar', length: 128 })
  public uca: string;

  @Column({ name: 'user_id', type: 'varchar', length: 128 })
  public userId: string;

  @Column({ type: 'varchar', length: 16 })
  public source: ClipSource;

  @Column({ type: 'varchar', length: 200 })
  public title: string;

  @Column({ type: 'varchar', length: 32 })
  public category: ClipCategory;

  @Column({ type: 'simple-json' })
  public tags: string[];

  @Column({ type: 'varchar', length: 16 })
  public priority: ClipPriority;

  @Column({ name: 'start_server_ms', type: 'integer' })
  public startServerMs: number;

  @Column({ name: 'end_server_ms', type: 'integer' })
  public endServerMs: number;

  @Column({ type: 'varchar', length: 32 })
  public status: ClipTaskStatus;

  @Column({ type: 'real', default: 0 })
  public progress: number;

  @Column({ name: 'max_attempts', type: 'integer' })
  public maxAttempts: number;

  @Column({ name: 'error_code', type: 'varchar', length: 64, nullable: true })
  public errorCode: string | null;

  @Column({ name: 'error_message', type: 'varchar', length: 500, nullable: true })
  public errorMessage: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 200, nullable: true })
  public idempotencyKey: string | null;

  @Column({ name: 'expires_at', type: 'integer' })
  public expiresAt: number;

  @Column({ name: 'created_at', type: 'integer' })
  public createdAt: number;

  @Column({ name: 'updated_at', type: 'integer' })
  public updatedAt: number;
}
