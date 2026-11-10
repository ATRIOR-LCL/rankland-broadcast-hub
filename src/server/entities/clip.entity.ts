import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ClipCategory, ClipSource, ClipStatus } from '@common/modules/clip/clip.dto';

@Entity('clip')
@Index('IDX_clip_uca_status_created', ['uca', 'status', 'createdAt'])
@Index('IDX_clip_item', ['itemId'], { unique: true })
export class ClipEntity {
  @PrimaryColumn({ name: 'clip_id', type: 'varchar', length: 36 })
  public clipId: string;

  @Column({ type: 'varchar', length: 128 })
  public uca: string;

  @Column({ name: 'task_id', type: 'varchar', length: 36 })
  public taskId: string;

  /** 每个任务项至多一个切片 */
  @Column({ name: 'item_id', type: 'varchar', length: 36 })
  public itemId: string;

  @Column({ name: 'user_id', type: 'varchar', length: 128 })
  public userId: string;

  @Column({ name: 'track_id', type: 'varchar', length: 128 })
  public trackId: string;

  @Column({ type: 'varchar', length: 16 })
  public source: ClipSource;

  @Column({ type: 'varchar', length: 32 })
  public category: ClipCategory;

  @Column({ type: 'varchar', length: 200 })
  public title: string;

  @Column({ type: 'simple-json' })
  public tags: string[];

  /** 相对存储根的路径 */
  @Column({ name: 'media_path', type: 'varchar', length: 512 })
  public mediaPath: string;

  @Column({ name: 'thumbnail_path', type: 'varchar', length: 512, nullable: true })
  public thumbnailPath: string | null;

  @Column({ name: 'thumbnail_mime_type', type: 'varchar', length: 32, nullable: true })
  public thumbnailMimeType: string | null;

  @Column({ name: 'mime_type', type: 'varchar', length: 32 })
  public mimeType: string;

  @Column({ name: 'byte_size', type: 'integer' })
  public byteSize: number;

  @Column({ name: 'duration_ms', type: 'integer' })
  public durationMs: number;

  @Column({ type: 'integer', nullable: true })
  public width: number | null;

  @Column({ type: 'integer', nullable: true })
  public height: number | null;

  @Column({ name: 'video_codec', type: 'varchar', length: 32, nullable: true })
  public videoCodec: string | null;

  @Column({ name: 'audio_codec', type: 'varchar', length: 32, nullable: true })
  public audioCodec: string | null;

  @Column({ name: 'checksum_sha256', type: 'varchar', length: 64 })
  public checksumSha256: string;

  @Column({ name: 'actual_start_server_ms', type: 'integer' })
  public actualStartServerMs: number;

  @Column({ name: 'actual_end_server_ms', type: 'integer' })
  public actualEndServerMs: number;

  @Column({ type: 'varchar', length: 16 })
  public status: ClipStatus;

  /** 文件已清理 */
  @Column({ name: 'files_removed', type: 'boolean', default: false })
  public filesRemoved: boolean;

  @Column({ name: 'expires_at', type: 'integer' })
  public expiresAt: number;

  @Column({ name: 'created_at', type: 'integer' })
  public createdAt: number;

  @Column({ name: 'deleted_at', type: 'integer', nullable: true })
  public deletedAt: number | null;
}
