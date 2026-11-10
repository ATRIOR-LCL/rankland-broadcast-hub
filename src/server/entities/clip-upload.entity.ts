import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type {
  ClipUploadRole,
  CompleteClipUploadMetadataDTO,
  CompleteClipUploadThumbnailDTO,
} from '@common/modules/clip/clip.dto';

export interface ClipUploadCompletePayload {
  metadata: CompleteClipUploadMetadataDTO;
  thumbnail: CompleteClipUploadThumbnailDTO | null;
}

export type ClipUploadStatus = 'created' | 'uploading' | 'completed' | 'failed' | 'expired';

@Entity('clip_upload')
@Index('IDX_clip_upload_item', ['itemId', 'generation', 'role'])
@Index('IDX_clip_upload_status', ['status', 'expiresAt'])
export class ClipUploadEntity {
  @PrimaryColumn({ name: 'upload_id', type: 'varchar', length: 36 })
  public uploadId: string;

  @Column({ type: 'varchar', length: 128 })
  public uca: string;

  @Column({ name: 'task_id', type: 'varchar', length: 36 })
  public taskId: string;

  @Column({ name: 'item_id', type: 'varchar', length: 36 })
  public itemId: string;

  @Column({ type: 'integer' })
  public generation: number;

  @Column({ type: 'varchar', length: 16 })
  public role: ClipUploadRole;

  @Column({ type: 'varchar', length: 16 })
  public status: ClipUploadStatus;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  public fileName: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 32 })
  public mimeType: string;

  @Column({ name: 'upload_length', type: 'integer' })
  public uploadLength: number;

  @Column({ name: 'checksum_sha256', type: 'varchar', length: 64 })
  public checksumSha256: string;

  /** 已落盘确认的字节数 */
  @Column({ name: 'upload_offset', type: 'integer', default: 0 })
  public uploadOffset: number;

  /** complete 提交的元数据 */
  @Column({ name: 'complete_payload', type: 'simple-json', nullable: true })
  public completePayload: ClipUploadCompletePayload | null;

  /** complete 时预分配的 clipId */
  @Column({ name: 'clip_id', type: 'varchar', length: 36, nullable: true })
  public clipId: string | null;

  @Column({ name: 'expires_at', type: 'integer' })
  public expiresAt: number;

  @Column({ name: 'created_at', type: 'integer' })
  public createdAt: number;

  @Column({ name: 'updated_at', type: 'integer' })
  public updatedAt: number;
}
