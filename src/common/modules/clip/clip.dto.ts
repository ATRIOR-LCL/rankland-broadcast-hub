import { FromBody, FromParam, FromQuery } from 'bwcx-common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const CLIP_CATEGORIES = ['firstBlood', 'accepted', 'manual', 'other'] as const;
export const CLIP_PRIORITIES = ['low', 'normal', 'high'] as const;
export const CLIP_TASK_STATUSES = [
  'queued',
  'requested',
  'client_processing',
  'uploading',
  'verifying',
  'ready',
  'partial_ready',
  'failed',
  'cancelled',
  'expired',
] as const;
export const CLIP_STATUSES = ['ready', 'deleted', 'expired'] as const;
export const CLIP_MEDIA_MIME_TYPES = ['video/mp4', 'video/webm'] as const;
export const CLIP_THUMBNAIL_MIME_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;

/** 本版只支持手动来源 */
export type ClipSource = 'manual';
export type ClipCategory = (typeof CLIP_CATEGORIES)[number];
export type ClipPriority = (typeof CLIP_PRIORITIES)[number];
export type ClipTaskStatus = (typeof CLIP_TASK_STATUSES)[number];
export type ClipTaskItemStatus = Exclude<ClipTaskStatus, 'partial_ready' | 'expired'>;
export type ClipStatus = (typeof CLIP_STATUSES)[number];
export type ClipUploadRole = 'media' | 'thumbnail';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// 实体
// ---------------------------------------------------------------------------

export class ClipTaskItemDTO {
  public itemId: string;
  public taskId: string;
  public uca: string;
  public userId: string;
  public trackId: string;
  public status: ClipTaskItemStatus;
  public uploadId?: string;
  public clipId?: string;
  public progress: number;
  public errorCode?: string;
  public errorMessage?: string;
  public actualStartServerMs?: number;
  public actualEndServerMs?: number;
  public createdAt: number;
  public updatedAt: number;
}

export class ClipTaskDTO {
  public taskId: string;
  public uca: string;
  public source: ClipSource;
  public title: string;
  public category: ClipCategory;
  public tags: string[];
  public priority: ClipPriority;
  public userId: string;
  public status: ClipTaskStatus;
  public startServerMs: number;
  public endServerMs: number;
  public attempts: number;
  public maxAttempts: number;
  public progress: number;
  public errorCode?: string;
  public errorMessage?: string;
  public items: ClipTaskItemDTO[];
  public createdClipIds: string[];
  public createdAt: number;
  public updatedAt: number;
  public expiresAt: number;
}

export class ClipDTO {
  public clipId: string;
  public uca: string;
  public taskId: string;
  public itemId: string;
  public userId: string;
  public trackId: string;
  public source: ClipSource;
  public category: ClipCategory;
  public title: string;
  public tags: string[];
  public mimeType: string;
  public byteSize: number;
  public durationMs: number;
  public width?: number;
  public height?: number;
  public videoCodec?: string;
  public audioCodec?: string;
  public checksumSha256: string;
  public actualStartServerMs: number;
  public actualEndServerMs: number;
  public thumbnailUrl?: string;
  public mediaUrl: string;
  public status: ClipStatus;
  public createdAt: number;
  public expiresAt: number;
}

// ---------------------------------------------------------------------------
// 切片任务（导播）
// ---------------------------------------------------------------------------

export class CreateClipTaskReqDTO {
  @FromBody()
  @IsIn(['manual'])
  public source: ClipSource;

  @FromBody()
  @IsString()
  @IsNotEmpty()
  public userId: string;

  @FromBody()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(16)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  public trackIds: string[];

  @FromBody()
  @IsInt()
  @Min(0)
  public startServerMs: number;

  @FromBody()
  @IsInt()
  @Min(0)
  public endServerMs: number;

  @FromBody()
  @IsString()
  @Length(1, 200)
  public title: string;

  @FromBody()
  @IsIn(CLIP_CATEGORIES)
  public category: ClipCategory;

  @FromBody()
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 64, { each: true })
  public tags?: string[];

  @FromBody()
  @IsOptional()
  @IsIn(CLIP_PRIORITIES)
  public priority?: ClipPriority;

  @FromBody()
  @IsOptional()
  @IsInt()
  @Min(1)
  public maxAttempts?: number;

  @FromBody()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  public idempotencyKey?: string;
}

export class CreateClipTaskRespDTO {
  public task: ClipTaskDTO;
}

export class ListClipTasksReqDTO {
  @FromQuery()
  @IsOptional()
  @IsIn(['manual'])
  public source?: ClipSource;

  @FromQuery()
  @IsOptional()
  @IsString()
  public userId?: string;

  @FromQuery()
  @IsOptional()
  @IsIn(CLIP_TASK_STATUSES)
  public status?: ClipTaskStatus;

  @FromQuery()
  @IsOptional()
  @IsIn(CLIP_CATEGORIES)
  public category?: ClipCategory;

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  public page?: number;

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  public pageSize?: number;
}

export class ListClipTasksRespDTO {
  public tasks: ClipTaskDTO[];
  public total: number;
  public page: number;
  public pageSize: number;
}

export class GetClipTaskReqDTO {
  @FromParam()
  @IsUUID()
  public taskId: string;
}

export class GetClipTaskRespDTO {
  public task: ClipTaskDTO;
}

// ---------------------------------------------------------------------------
// 进度与上传（选手）
// ---------------------------------------------------------------------------

export class ReportClipTaskProgressReqDTO {
  @FromParam()
  @IsUUID()
  public taskId: string;

  @FromBody()
  @IsUUID()
  public itemId: string;

  @FromBody()
  @IsInt()
  @Min(1)
  public generation: number;

  @FromBody()
  @IsOptional()
  @IsIn(['client_processing', 'uploading', 'failed'])
  public status?: 'client_processing' | 'uploading' | 'failed';

  @FromBody()
  @IsNumber()
  @Min(0)
  @Max(99)
  public progress: number;

  @FromBody()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public message?: string;

  @FromBody()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public errorCode?: string;

  @FromBody()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public errorMessage?: string;
}

export class ReportClipTaskProgressRespDTO {
  public task: ClipTaskDTO;
}

export class CreateClipUploadReqDTO {
  @FromParam()
  @IsUUID()
  public taskId: string;

  @FromBody()
  @IsUUID()
  public itemId: string;

  @FromBody()
  @IsInt()
  @Min(1)
  public generation: number;

  @FromBody()
  @IsString()
  @IsNotEmpty()
  public trackId: string;

  @FromBody()
  @IsIn(['media', 'thumbnail'])
  public role: ClipUploadRole;

  @FromBody()
  @IsString()
  @Length(1, 255)
  public fileName: string;

  @FromBody()
  @IsIn([...CLIP_MEDIA_MIME_TYPES, ...CLIP_THUMBNAIL_MIME_TYPES])
  public mimeType: string;

  @FromBody()
  @IsInt()
  @Min(1)
  public uploadLength: number;

  @FromBody()
  @Matches(SHA256_PATTERN)
  public checksumSha256: string;
}

export class CreateClipUploadRespDTO {
  public uploadId: string;
  public uploadUrl: string;
  public offset: number;
  public expiresAt: number;
}

/** 上传 HEAD/PATCH 路径参数 */
export class ClipUploadParamReqDTO {
  @FromParam()
  @IsUUID()
  public uploadId: string;
}

export class CompleteClipUploadMetadataDTO {
  @IsInt()
  @Min(0)
  public actualStartServerMs: number;

  @IsInt()
  @Min(0)
  public actualEndServerMs: number;

  @IsInt()
  @Min(1)
  public durationMs: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  public width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  public height?: number;

  @IsOptional()
  @IsString()
  public videoCodec?: string;

  @IsOptional()
  @IsString()
  public audioCodec?: string;

  @IsIn(['mp4', 'webm'])
  public container: 'mp4' | 'webm';

  @IsOptional()
  @IsPositive()
  public bitrate?: number;

  @IsOptional()
  @IsPositive()
  public frameRate?: number;
}

export class CompleteClipUploadThumbnailDTO {
  @IsIn(CLIP_THUMBNAIL_MIME_TYPES)
  public mimeType: string;

  @IsInt()
  @Min(1)
  public byteSize: number;

  @Matches(SHA256_PATTERN)
  public checksumSha256: string;

  @IsUUID()
  public uploadId: string;
}

export class CompleteClipUploadReqDTO {
  @FromParam()
  @IsUUID()
  public uploadId: string;

  @FromBody()
  @ValidateNested()
  @Type(() => CompleteClipUploadMetadataDTO)
  public metadata: CompleteClipUploadMetadataDTO;

  @FromBody()
  @IsOptional()
  @ValidateNested()
  @Type(() => CompleteClipUploadThumbnailDTO)
  public thumbnail?: CompleteClipUploadThumbnailDTO;
}

export class CompleteClipUploadRespDTO {
  public task: ClipTaskDTO;
  public clip?: ClipDTO;
}

// ---------------------------------------------------------------------------
// 切片消费（导播）
// ---------------------------------------------------------------------------

export class ListClipsReqDTO {
  @FromQuery()
  @IsOptional()
  @IsString()
  public userId?: string;

  @FromQuery()
  @IsOptional()
  @IsString()
  public trackId?: string;

  @FromQuery()
  @IsOptional()
  @IsIn(['manual'])
  public source?: ClipSource;

  @FromQuery()
  @IsOptional()
  @IsIn(CLIP_CATEGORIES)
  public category?: ClipCategory;

  @FromQuery()
  @IsOptional()
  @IsIn(CLIP_STATUSES)
  public status?: ClipStatus;

  @FromQuery()
  @IsOptional()
  @IsString()
  public tag?: string;

  @FromQuery()
  @IsOptional()
  @IsInt()
  public createdAfter?: number;

  @FromQuery()
  @IsOptional()
  @IsInt()
  public createdBefore?: number;

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  public page?: number;

  @FromQuery()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  public pageSize?: number;
}

export class ListClipsRespDTO {
  public clips: ClipDTO[];
  public total: number;
  public page: number;
  public pageSize: number;
}

/** 切片媒体/缩略图/删除路径参数 */
export class ClipParamReqDTO {
  @FromParam()
  @IsUUID()
  public clipId: string;
}

export class DeleteClipRespDTO {
  public clipId: string;
  public status: 'deleted';
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

export interface RequestCreateClipPayload {
  taskId: string;
  uca: string;
  userId: string;
  startServerMs: number;
  endServerMs: number;
  items: {
    itemId: string;
    generation: number;
    trackId: string;
    uploadToken: string;
    uploadTokenExpiresAt: number;
  }[];
  preferred: {
    containers: ('mp4' | 'webm')[];
    maxUploadBytes: number;
  };
}

export interface RequestCreateClipAck {
  accepted: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface SubscribeClipsReq {
  categories?: ClipCategory[];
  userIds?: string[];
}
