import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Readable } from 'stream';
import { Inject, Provide } from 'bwcx-core';
import { In, type DataSource, type EntityManager } from 'typeorm';
import { ErrCode } from '@common/enums/err-code.enum';
import type {
  ClipDTO,
  ClipTaskDTO,
  ClipTaskItemStatus,
  ClipTaskStatus,
  CompleteClipUploadReqDTO,
  CompleteClipUploadRespDTO,
  CreateClipTaskReqDTO,
  CreateClipUploadReqDTO,
  CreateClipUploadRespDTO,
  ListClipsReqDTO,
  ListClipsRespDTO,
  ListClipTasksReqDTO,
  ListClipTasksRespDTO,
  ReportClipTaskProgressReqDTO,
  RequestCreateClipPayload,
} from '@common/modules/clip/clip.dto';
import ClipConfig from '@server/configs/clip/clip.config';
import TypeOrmClient from '@server/database/typeorm-client';
import { ClipTaskEntity } from '@server/entities/clip-task.entity';
import { ClipTaskItemEntity } from '@server/entities/clip-task-item.entity';
import { ClipUploadEntity } from '@server/entities/clip-upload.entity';
import { ClipEntity } from '@server/entities/clip.entity';
import ClipHttpException from '@server/exceptions/clip-http.exception';
import LogicException from '@server/exceptions/logic.exception';
import MiscUtils from '@server/utils/misc.util';
import LiveContestService from '../live-contest/live-contest.service';
import SocketIOServer from '../socket-io/socket-io';

export interface ClipFileInfo {
  path: string;
  size: number;
  mimeType: string;
  etag: string;
}

const DISPATCH_INTERVAL_MS = 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 选手端仍在处理中的任务项状态 */
const CLIENT_STATUSES: ClipTaskItemStatus[] = ['requested', 'client_processing', 'uploading'];
/** 活动状态，按流程先后排列，任务状态取最早的一个 */
const ACTIVE_STATUSES: ClipTaskItemStatus[] = ['queued', 'requested', 'client_processing', 'uploading', 'verifying'];
const RETRYABLE_ERRORS = [
  'target_offline',
  'dispatch_timeout',
  'token_expired',
  'client_busy',
  'client_not_ready',
  'clock_not_synchronized',
  'processing_timeout',
];

/** 媒体校验不通过（不可重试） */
class ClipVerifyError extends Error {
  public constructor(public readonly errorCode: string, message: string) {
    super(message);
  }
}

@Provide()
export default class ClipService {
  private writeQueue: Promise<unknown> = Promise.resolve();
  private verifyQueue: Promise<unknown> = Promise.resolve();
  private readonly uploadLocks = new Map<string, Promise<unknown>>();
  private dispatchTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private dispatching = false;
  private cleaning = false;

  public constructor(
    @Inject(TypeOrmClient) private readonly typeOrmClient: TypeOrmClient,
    @Inject() private readonly clipConfig: ClipConfig,
    @Inject() private readonly liveContestService: LiveContestService,
    @Inject() private readonly socketIOServer: SocketIOServer,
    @Inject() private readonly miscUtils: MiscUtils,
  ) {}

  private get dataSource(): DataSource {
    return this.typeOrmClient.getDataSource();
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  /**
   * 启动恢复并开始定时任务，需在 Socket.io 初始化之后调用
   */
  public async start() {
    // 接收中的临时文件截断到已确认 offset
    const receiving = await this.dataSource.getRepository(ClipUploadEntity).find({
      where: { status: In(['created', 'uploading']) },
    });
    for (const upload of receiving) {
      if (upload.completePayload) {
        continue;
      }
      const size = await this.statSize(this.uploadPath(upload));
      if (size !== null && size > upload.uploadOffset) {
        await fs.promises.truncate(this.uploadPath(upload), upload.uploadOffset);
      } else if (size !== null && size < upload.uploadOffset) {
        // 已确认内容丢失，回退到实际长度，最终由完整 SHA-256 校验兜底
        await this.write((m) => m.update(ClipUploadEntity, upload.uploadId, { uploadOffset: size }));
      }
    }
    // 重启前已下发但未收到 ACK 的项重新排队
    const requested = await this.dataSource.getRepository(ClipTaskItemEntity).find({ where: { status: 'requested' } });
    for (const item of requested) {
      await this.write((m) => this.failItem(m, item, 'dispatch_timeout', 'hub restarted', true));
    }
    // 重启前未完成的校验重新执行
    const verifying = await this.dataSource.getRepository(ClipTaskItemEntity).find({ where: { status: 'verifying' } });
    for (const item of verifying) {
      const upload = await this.dataSource.getRepository(ClipUploadEntity).findOne({
        where: { itemId: item.itemId, generation: item.generation, role: 'media' },
        order: { createdAt: 'DESC' },
      });
      if (upload?.completePayload) {
        this.enqueueVerify(upload.uploadId);
      }
    }

    this.dispatchTimer = setInterval(() => this.dispatchDue(), DISPATCH_INTERVAL_MS);
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanup();
  }

  public async stop() {
    if (this.dispatchTimer) {
      clearInterval(this.dispatchTimer);
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    await this.writeQueue;
  }

  // ---------------------------------------------------------------------------
  // 切片任务
  // ---------------------------------------------------------------------------

  public async createTask(uca: string, data: CreateClipTaskReqDTO): Promise<ClipTaskDTO> {
    if (data.idempotencyKey) {
      const existed = await this.dataSource
        .getRepository(ClipTaskEntity)
        .findOne({ where: { uca, idempotencyKey: data.idempotencyKey } });
      if (existed) {
        return this.toTaskDTO(existed);
      }
    }
    const member = await this.liveContestService.findContestMemberById(uca, data.userId);
    if (!member) {
      throw new LogicException(ErrCode.LiveContestMemberNotFound);
    }
    const now = Date.now();
    const expiresAt = (await this.getContestEndTime(uca, now)) + this.clipConfig.retentionDays * DAY_MS;

    const task = await this.write(async (m) => {
      if (data.idempotencyKey) {
        const existed = await m.findOne(ClipTaskEntity, { where: { uca, idempotencyKey: data.idempotencyKey } });
        if (existed) {
          return existed;
        }
      }
      const created = m.create(ClipTaskEntity, {
        taskId: crypto.randomUUID(),
        uca,
        userId: data.userId,
        source: 'manual',
        title: data.title,
        category: data.category,
        tags: data.tags || [],
        priority: data.priority || 'normal',
        startServerMs: data.startServerMs,
        endServerMs: data.endServerMs,
        status: 'queued',
        progress: 0,
        maxAttempts: data.maxAttempts || this.clipConfig.taskMaxAttempts,
        errorCode: null,
        errorMessage: null,
        idempotencyKey: data.idempotencyKey || null,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      await m.insert(ClipTaskEntity, created);
      await m.insert(
        ClipTaskItemEntity,
        data.trackIds.map((trackId) =>
          m.create(ClipTaskItemEntity, {
            itemId: crypto.randomUUID(),
            uca,
            taskId: created.taskId,
            userId: data.userId,
            trackId,
            status: 'queued',
            progress: 0,
            attempts: 0,
            generation: 0,
            nextAttemptAt: now,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );
      return created;
    });
    this.dispatchDue();
    return this.notifyTask(task.taskId);
  }

  public async listTasks(uca: string, data: ListClipTasksReqDTO): Promise<ListClipTasksRespDTO> {
    const page = data.page || 1;
    const pageSize = data.pageSize || 20;
    const [tasks, total] = await this.dataSource.getRepository(ClipTaskEntity).findAndCount({
      where: { uca, source: data.source, userId: data.userId, status: data.status, category: data.category },
      order: { createdAt: 'DESC', taskId: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      tasks: await this.toTaskDTOs(tasks),
      total,
      page,
      pageSize,
    };
  }

  public async getTask(uca: string, taskId: string): Promise<ClipTaskDTO> {
    const task = await this.dataSource.getRepository(ClipTaskEntity).findOne({ where: { uca, taskId } });
    if (!task) {
      throw new LogicException(ErrCode.ClipTaskNotFound);
    }
    return this.toTaskDTO(task);
  }

  // ---------------------------------------------------------------------------
  // 下发与重试
  // ---------------------------------------------------------------------------

  /**
   * 处理凭证到期，并按任务合并下发到期的排队项
   */
  public async dispatchDue() {
    if (this.dispatching) {
      return;
    }
    this.dispatching = true;
    try {
      const now = Date.now();
      const itemRepository = this.dataSource.getRepository(ClipTaskItemEntity);
      const active = await itemRepository.find({ where: { status: In(CLIENT_STATUSES) } });
      for (const item of active.filter((i) => i.tokenExpiresAt !== null && i.tokenExpiresAt <= now)) {
        await this.write((m) => this.failItem(m, item, 'token_expired', 'upload token expired', true));
        await this.notifyTask(item.taskId);
      }

      const queued = await itemRepository.find({ where: { status: 'queued' } });
      const taskIds = [...new Set(queued.filter((i) => (i.nextAttemptAt || 0) <= now).map((i) => i.taskId))];
      for (const taskId of taskIds) {
        const payload = await this.prepareDispatch(taskId);
        await this.notifyTask(taskId);
        if (payload) {
          // 等待 ACK 期间不阻塞后续轮询；项已为 requested，不会被重复选中
          this.deliver(payload).catch((e) => console.error('[clip] deliver failed', payload.taskId, e));
        }
      }
    } catch (e) {
      console.error('[clip] dispatch failed', e);
    } finally {
      this.dispatching = false;
    }
  }

  private prepareDispatch(taskId: string) {
    const now = Date.now();
    return this.write(async (m) => {
      const task = await m.findOneByOrFail(ClipTaskEntity, { taskId });
      const items = await m.find(ClipTaskItemEntity, { where: { taskId, status: 'queued' } });
      const payloadItems: RequestCreateClipPayload['items'] = [];
      for (const item of items.filter((i) => (i.nextAttemptAt || 0) <= now)) {
        if (item.attempts >= task.maxAttempts) {
          await this.failItem(m, item, item.errorCode || 'attempts_exhausted', item.errorMessage, false);
          continue;
        }
        const uploadToken = crypto.randomBytes(32).toString('hex');
        const generation = item.generation + 1;
        const tokenExpiresAt = now + this.clipConfig.uploadTokenTtlMs;
        await m.update(ClipTaskItemEntity, item.itemId, {
          status: 'requested',
          attempts: item.attempts + 1,
          generation,
          tokenHash: sha256(uploadToken),
          tokenExpiresAt,
          nextAttemptAt: null,
          progress: 0,
          updatedAt: now,
        });
        payloadItems.push({
          itemId: item.itemId,
          generation,
          trackId: item.trackId,
          uploadToken,
          uploadTokenExpiresAt: tokenExpiresAt,
        });
        console.log(`[clip] [dispatch] [${task.uca}] task ${taskId} item ${item.itemId} attempt ${item.attempts + 1}`);
      }
      await this.refreshTask(m, taskId);
      if (payloadItems.length === 0) {
        return null;
      }
      const payload: RequestCreateClipPayload = {
        taskId,
        uca: task.uca,
        userId: task.userId,
        startServerMs: task.startServerMs,
        endServerMs: task.endServerMs,
        items: payloadItems,
        preferred: { containers: ['mp4', 'webm'], maxUploadBytes: this.clipConfig.maxUploadBytes },
      };
      return payload;
    });
  }

  private async deliver(payload: RequestCreateClipPayload) {
    const result = await this.socketIOServer.requestCreateClip(
      payload.uca,
      payload.userId,
      payload,
      this.clipConfig.ackTimeoutMs,
    );
    await this.write(async (m) => {
      for (const sent of payload.items) {
        const item = await m.findOneBy(ClipTaskItemEntity, { itemId: sent.itemId });
        if (!item || item.generation !== sent.generation || item.status !== 'requested') {
          continue;
        }
        if (result.kind === 'offline') {
          await this.failItem(m, item, 'target_offline', 'broadcaster is offline', true);
        } else if (result.kind === 'timeout') {
          await this.failItem(m, item, 'dispatch_timeout', 'broadcaster did not acknowledge', true);
        } else if (result.ack.accepted) {
          await m.update(ClipTaskItemEntity, item.itemId, {
            status: 'client_processing',
            errorCode: null,
            errorMessage: null,
            updatedAt: Date.now(),
          });
        } else {
          const code = result.ack.errorCode || 'client_rejected';
          await this.failItem(m, item, code, result.ack.errorMessage || null, RETRYABLE_ERRORS.includes(code));
        }
      }
      await this.refreshTask(m, payload.taskId);
    });
    await this.notifyTask(payload.taskId);
  }

  /**
   * 任务项本轮失败：可重试且有剩余次数则重新排队，否则失败；本代未完成的上传会话一并失效
   */
  private async failItem(
    m: EntityManager,
    item: ClipTaskItemEntity,
    errorCode: string,
    errorMessage: string | null,
    retryable: boolean,
  ) {
    const now = Date.now();
    const task = await m.findOneByOrFail(ClipTaskEntity, { taskId: item.taskId });
    const retry = retryable && item.attempts < task.maxAttempts;
    await m.update(ClipTaskItemEntity, item.itemId, {
      status: retry ? 'queued' : 'failed',
      progress: retry ? 0 : 100,
      errorCode,
      errorMessage,
      nextAttemptAt: retry ? now + this.clipConfig.retryDelayMs : null,
      updatedAt: now,
    });
    await m.update(
      ClipUploadEntity,
      { itemId: item.itemId, status: In(['created', 'uploading']) },
      { status: 'failed', updatedAt: now },
    );
    await this.refreshTask(m, item.taskId);
    console.log(`[clip] [item] [${item.uca}] item ${item.itemId} ${retry ? 'retry' : 'failed'}: ${errorCode}`);
  }

  /**
   * 按任务项聚合任务状态与进度
   */
  private async refreshTask(m: EntityManager, taskId: string) {
    const task = await m.findOneByOrFail(ClipTaskEntity, { taskId });
    const items = await m.find(ClipTaskItemEntity, { where: { taskId } });
    const active = ACTIVE_STATUSES.find((s) => items.some((i) => i.status === s));
    let status: ClipTaskStatus;
    if (task.status === 'expired') {
      status = 'expired';
    } else if (active) {
      status = active;
    } else if (items.every((i) => i.status === 'ready')) {
      status = 'ready';
    } else if (items.some((i) => i.status === 'ready')) {
      status = 'partial_ready';
    } else {
      status = 'failed';
    }
    const failed = active ? undefined : items.find((i) => i.status === 'failed');
    const progress = items.reduce((sum, i) => sum + i.progress, 0) / Math.max(items.length, 1);
    await m.update(ClipTaskEntity, taskId, {
      status,
      progress: Math.round(progress * 100) / 100,
      errorCode: failed?.errorCode || null,
      errorMessage: failed?.errorMessage || null,
      updatedAt: Date.now(),
    });
  }

  // ---------------------------------------------------------------------------
  // 进度与上传（选手）
  // ---------------------------------------------------------------------------

  public async reportProgress(uca: string, token: string, data: ReportClipTaskProgressReqDTO): Promise<ClipTaskDTO> {
    const item = await this.dataSource
      .getRepository(ClipTaskItemEntity)
      .findOne({ where: { uca, itemId: data.itemId } });
    if (!item || item.taskId !== data.taskId || this.checkItemToken(item, token, data.generation) !== 'ok') {
      throw new LogicException(ErrCode.ClipUploadExpired);
    }
    if (!CLIENT_STATUSES.includes(item.status)) {
      throw new LogicException(ErrCode.ClipUploadInvalidState);
    }
    await this.write(async (m) => {
      if (data.status === 'failed') {
        const code = data.errorCode || 'client_failed';
        await this.failItem(m, item, code, data.errorMessage || null, RETRYABLE_ERRORS.includes(code));
        return;
      }
      // 状态与进度都不回退
      const status =
        data.status && CLIENT_STATUSES.indexOf(data.status) > CLIENT_STATUSES.indexOf(item.status)
          ? data.status
          : item.status;
      await m.update(ClipTaskItemEntity, item.itemId, {
        status,
        progress: Math.max(item.progress, data.progress),
        updatedAt: Date.now(),
      });
      await this.refreshTask(m, item.taskId);
    });
    return this.notifyTask(item.taskId);
  }

  public async createUpload(
    uca: string,
    token: string,
    data: CreateClipUploadReqDTO,
  ): Promise<CreateClipUploadRespDTO> {
    const item = await this.dataSource
      .getRepository(ClipTaskItemEntity)
      .findOne({ where: { uca, itemId: data.itemId } });
    if (!item || item.taskId !== data.taskId || this.checkItemToken(item, token, data.generation) !== 'ok') {
      throw new LogicException(ErrCode.ClipUploadExpired);
    }
    if (item.trackId !== data.trackId) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    if (!CLIENT_STATUSES.includes(item.status)) {
      throw new LogicException(ErrCode.ClipUploadInvalidState);
    }

    const now = Date.now();
    const upload = await this.write(async (m) => {
      // 同代同角色同声明返回原会话
      const existed = await m.findOne(ClipUploadEntity, {
        where: {
          itemId: item.itemId,
          generation: item.generation,
          role: data.role,
          status: In(['created', 'uploading']),
        },
      });
      if (existed) {
        const same =
          existed.mimeType === data.mimeType &&
          existed.uploadLength === data.uploadLength &&
          existed.checksumSha256 === data.checksumSha256;
        if (!same) {
          throw new LogicException(ErrCode.ClipUploadConflict);
        }
        return existed;
      }
      if ((await this.getUsedStorageBytes(m)) + data.uploadLength > this.clipConfig.maxStorageBytes) {
        throw new LogicException(ErrCode.ClipStorageQuotaExceeded);
      }
      const created = m.create(ClipUploadEntity, {
        uploadId: crypto.randomUUID(),
        uca,
        taskId: item.taskId,
        itemId: item.itemId,
        generation: item.generation,
        role: data.role,
        status: 'created',
        fileName: data.fileName,
        mimeType: data.mimeType,
        uploadLength: data.uploadLength,
        checksumSha256: data.checksumSha256,
        uploadOffset: 0,
        completePayload: null,
        clipId: null,
        expiresAt: item.tokenExpiresAt!,
        createdAt: now,
        updatedAt: now,
      });
      await m.insert(ClipUploadEntity, created);
      await m.update(ClipTaskItemEntity, item.itemId, { status: 'uploading', updatedAt: now });
      await this.refreshTask(m, item.taskId);
      return created;
    });
    await this.notifyTask(item.taskId);
    return {
      uploadId: upload.uploadId,
      uploadUrl: `/api/clips/uploads/${upload.uploadId}`,
      offset: upload.uploadOffset,
      expiresAt: upload.expiresAt,
    };
  }

  public async getUploadState(uca: string, token: string, uploadId: string) {
    const { upload } = await this.authorizeUpload(uca, token, uploadId);
    return {
      offset: upload.uploadOffset,
      length: upload.uploadLength,
      expiresAt: upload.expiresAt,
    };
  }

  /**
   * 从 offset 追加 length 字节：写入并 fsync 后才确认 offset；失败时截断回已确认位置
   */
  public appendUpload(
    uca: string,
    token: string,
    uploadId: string,
    offset: number,
    length: number,
    body: Readable,
  ): Promise<number> {
    return this.withUploadLock(uploadId, async () => {
      const { upload } = await this.authorizeUpload(uca, token, uploadId);
      if (upload.completePayload) {
        throw new ClipHttpException(409, ErrCode.ClipUploadInvalidState);
      }
      if (offset !== upload.uploadOffset) {
        throw new ClipHttpException(409, ErrCode.ClipUploadOffsetMismatch, {
          'Upload-Offset': `${upload.uploadOffset}`,
        });
      }
      if (offset + length > upload.uploadLength) {
        throw new ClipHttpException(413, ErrCode.ClipStorageQuotaExceeded);
      }

      const filePath = this.uploadPath(upload);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const fh = await fs.promises.open(filePath, fs.constants.O_RDWR | fs.constants.O_CREAT);
      let written = 0;
      try {
        for await (const chunk of body as AsyncIterable<Buffer>) {
          if (written + chunk.length > length) {
            throw new ClipHttpException(400, ErrCode.IllegalParameters);
          }
          await fh.write(chunk, 0, chunk.length, offset + written);
          written += chunk.length;
        }
        if (written !== length) {
          throw new ClipHttpException(400, ErrCode.IllegalParameters);
        }
        await fh.sync();
      } catch (e) {
        await fh.truncate(upload.uploadOffset).catch(() => undefined);
        throw e instanceof ClipHttpException ? e : new ClipHttpException(400, ErrCode.IllegalParameters);
      } finally {
        await fh.close();
      }

      const newOffset = offset + length;
      await this.write((m) =>
        m.update(ClipUploadEntity, uploadId, { uploadOffset: newOffset, status: 'uploading', updatedAt: Date.now() }),
      );
      return newOffset;
    });
  }

  /**
   * 提交媒体元数据：持久化后进入后台校验，立即返回 verifying 的任务
   */
  public async completeUpload(
    uca: string,
    token: string,
    data: CompleteClipUploadReqDTO,
  ): Promise<CompleteClipUploadRespDTO> {
    const upload = await this.dataSource
      .getRepository(ClipUploadEntity)
      .findOne({ where: { uca, uploadId: data.uploadId } });
    if (!upload) {
      throw new LogicException(ErrCode.ClipUploadNotFound);
    }
    const item = await this.dataSource.getRepository(ClipTaskItemEntity).findOneByOrFail({ itemId: upload.itemId });
    if (this.checkItemToken(item, token, upload.generation) !== 'ok') {
      throw new LogicException(ErrCode.ClipUploadExpired);
    }
    if (upload.role !== 'media') {
      throw new LogicException(ErrCode.ClipUploadInvalidState);
    }
    // 重复提交返回当前结果
    if (upload.completePayload) {
      const clip = await this.dataSource.getRepository(ClipEntity).findOne({ where: { itemId: upload.itemId } });
      return {
        task: await this.getTask(uca, upload.taskId),
        clip: clip ? this.toClipDTO(clip) : undefined,
      };
    }
    if (upload.uploadOffset !== upload.uploadLength || !CLIENT_STATUSES.includes(item.status)) {
      throw new LogicException(ErrCode.ClipUploadInvalidState);
    }
    if (data.thumbnail) {
      const thumb = await this.dataSource
        .getRepository(ClipUploadEntity)
        .findOne({ where: { uca, uploadId: data.thumbnail.uploadId } });
      if (
        !thumb ||
        thumb.itemId !== upload.itemId ||
        thumb.generation !== upload.generation ||
        thumb.role !== 'thumbnail' ||
        thumb.uploadOffset !== thumb.uploadLength ||
        thumb.uploadLength !== data.thumbnail.byteSize ||
        thumb.checksumSha256 !== data.thumbnail.checksumSha256 ||
        thumb.mimeType !== data.thumbnail.mimeType
      ) {
        throw new LogicException(ErrCode.IllegalParameters);
      }
    }

    await this.write(async (m) => {
      const now = Date.now();
      await m.update(ClipUploadEntity, upload.uploadId, {
        completePayload: { metadata: data.metadata, thumbnail: data.thumbnail || null },
        clipId: crypto.randomUUID(),
        updatedAt: now,
      });
      await m.update(ClipTaskItemEntity, item.itemId, { status: 'verifying', updatedAt: now });
      await this.refreshTask(m, item.taskId);
    });
    this.enqueueVerify(upload.uploadId);
    return {
      task: await this.notifyTask(item.taskId),
    };
  }

  // ---------------------------------------------------------------------------
  // 校验与发布
  // ---------------------------------------------------------------------------

  private enqueueVerify(uploadId: string) {
    this.verifyQueue = this.verifyQueue
      .then(() => this.verifyAndPublish(uploadId))
      .catch((e) => console.error('[clip] verify crashed', uploadId, e));
  }

  private async verifyAndPublish(uploadId: string) {
    const upload = await this.dataSource.getRepository(ClipUploadEntity).findOneByOrFail({ uploadId });
    const item = await this.dataSource.getRepository(ClipTaskItemEntity).findOneByOrFail({ itemId: upload.itemId });
    const task = await this.dataSource.getRepository(ClipTaskEntity).findOneByOrFail({ taskId: upload.taskId });
    if (item.status !== 'verifying' || item.generation !== upload.generation || !upload.completePayload) {
      return;
    }
    const { metadata, thumbnail } = upload.completePayload;
    const clipId = upload.clipId!;
    const mediaPath = this.clipFilePath(upload.uca, clipId, 'media', upload.mimeType);
    const thumbUpload = thumbnail
      ? await this.dataSource.getRepository(ClipUploadEntity).findOneByOrFail({ uploadId: thumbnail.uploadId })
      : null;
    const thumbPath = thumbUpload ? this.clipFilePath(upload.uca, clipId, 'thumbnail', thumbUpload.mimeType) : null;

    let probed: ReturnType<ClipService['validateProbe']>;
    try {
      // 重启前文件可能已移动到正式路径
      const mediaSource = await this.existingPath(this.uploadPath(upload), this.absolute(mediaPath));
      await this.checkFile(mediaSource, upload.uploadLength, upload.checksumSha256);
      probed = this.validateProbe(await this.probe(mediaSource), metadata, task, upload.mimeType);
      if (thumbUpload) {
        const thumbSource = await this.existingPath(this.uploadPath(thumbUpload), this.absolute(thumbPath!));
        await this.checkFile(thumbSource, thumbUpload.uploadLength, thumbUpload.checksumSha256);
        if ((await sniffImage(thumbSource)) !== thumbUpload.mimeType) {
          throw new ClipVerifyError('media_validation_failed', 'thumbnail encoding mismatch');
        }
      }
      await this.moveIntoPlace(this.uploadPath(upload), this.absolute(mediaPath));
      if (thumbUpload) {
        await this.moveIntoPlace(this.uploadPath(thumbUpload), this.absolute(thumbPath!));
      }
    } catch (e) {
      const code = e instanceof ClipVerifyError ? e.errorCode : 'media_validation_failed';
      console.log(`[clip] [verify] [${upload.uca}] upload ${uploadId} failed: ${code} ${(e as Error).message}`);
      await this.write((m) => this.failItem(m, item, code, (e as Error).message.slice(0, 500), false));
      await this.removeFiles([this.uploadPath(upload), thumbUpload && this.uploadPath(thumbUpload)]);
      await this.notifyTask(item.taskId);
      return;
    }

    const clip = await this.write(async (m) => {
      const now = Date.now();
      const created = m.create(ClipEntity, {
        clipId,
        uca: upload.uca,
        taskId: task.taskId,
        itemId: item.itemId,
        userId: item.userId,
        trackId: item.trackId,
        source: task.source,
        category: task.category,
        title: task.title,
        tags: task.tags,
        mediaPath,
        thumbnailPath: thumbPath,
        thumbnailMimeType: thumbUpload?.mimeType || null,
        mimeType: upload.mimeType,
        byteSize: upload.uploadLength,
        durationMs: probed.durationMs,
        width: probed.width,
        height: probed.height,
        videoCodec: probed.videoCodec,
        audioCodec: probed.audioCodec,
        checksumSha256: upload.checksumSha256,
        actualStartServerMs: metadata.actualStartServerMs,
        actualEndServerMs: metadata.actualEndServerMs,
        status: 'ready',
        filesRemoved: false,
        expiresAt: task.expiresAt,
        createdAt: now,
        deletedAt: null,
      });
      await m.insert(ClipEntity, created);
      await m.update(
        ClipUploadEntity,
        { uploadId: In([upload.uploadId, thumbUpload?.uploadId].filter(Boolean)) },
        { status: 'completed', updatedAt: now },
      );
      await m.update(ClipTaskItemEntity, item.itemId, {
        status: 'ready',
        progress: 100,
        errorCode: null,
        errorMessage: null,
        actualStartServerMs: metadata.actualStartServerMs,
        actualEndServerMs: metadata.actualEndServerMs,
        updatedAt: now,
      });
      await this.refreshTask(m, task.taskId);
      return created;
    });
    console.log(`[clip] [publish] [${clip.uca}] clip ${clip.clipId} for item ${item.itemId}`);
    this.socketIOServer.emitClipEvent(clip.uca, clip.category, clip.userId, 'clipCreated', {
      clip: this.toClipDTO(clip),
    });
    await this.notifyTask(task.taskId);
  }

  private async checkFile(filePath: string, size: number, checksumSha256: string) {
    if ((await this.statSize(filePath)) !== size) {
      throw new ClipVerifyError('media_validation_failed', 'file size mismatch');
    }
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) {
      hash.update(chunk);
    }
    if (hash.digest('hex') !== checksumSha256) {
      throw new ClipVerifyError('upload_checksum_mismatch', 'checksum mismatch');
    }
  }

  private probe(filePath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      execFile(
        this.clipConfig.ffprobePath,
        ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
        { timeout: this.clipConfig.verifyTimeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            reject(new ClipVerifyError('media_validation_failed', `ffprobe failed: ${err.message}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            reject(new ClipVerifyError('media_validation_failed', 'ffprobe output is not JSON'));
          }
        },
      );
    });
  }

  /**
   * 校验容器、编码、时长及实际时间窗：MP4 需 H.264（音频 AAC），WebM 需 VP8/VP9（音频 Opus）
   */
  private validateProbe(
    probe: any,
    metadata: CompleteClipUploadReqDTO['metadata'],
    task: ClipTaskEntity,
    mimeType: string,
  ) {
    const fail = (message: string): never => {
      throw new ClipVerifyError('media_validation_failed', message);
    };
    const isMp4 = mimeType === 'video/mp4';
    const formatName: string = probe.format?.format_name || '';
    if (isMp4 ? !formatName.includes('mp4') : !formatName.includes('webm')) {
      fail(`unexpected container ${formatName}`);
    }
    if (metadata.container !== (isMp4 ? 'mp4' : 'webm')) {
      fail('declared container mismatch');
    }
    const streams: any[] = probe.streams || [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    if (!video || !(isMp4 ? ['h264'] : ['vp8', 'vp9']).includes(video.codec_name)) {
      fail(`unexpected video codec ${video?.codec_name}`);
    }
    if (audio && audio.codec_name !== (isMp4 ? 'aac' : 'opus')) {
      fail(`unexpected audio codec ${audio.codec_name}`);
    }
    const durationMs = Math.round(parseFloat(probe.format?.duration) * 1000);
    if (!(durationMs > 0) || durationMs > this.clipConfig.maxDurationMs) {
      fail(`invalid duration ${durationMs}`);
    }
    if (Math.abs(durationMs - metadata.durationMs) > 1000) {
      fail('declared duration mismatch');
    }
    if (metadata.actualStartServerMs > task.startServerMs || metadata.actualEndServerMs < task.endServerMs) {
      fail('actual window does not cover requested window');
    }
    return {
      durationMs,
      width: video.width as number,
      height: video.height as number,
      videoCodec: video.codec_name as string,
      audioCodec: (audio?.codec_name as string) || null,
    };
  }

  // ---------------------------------------------------------------------------
  // 切片消费
  // ---------------------------------------------------------------------------

  public async listClips(uca: string, data: ListClipsReqDTO): Promise<ListClipsRespDTO> {
    const page = data.page || 1;
    const pageSize = data.pageSize || 20;
    const status = data.status || 'ready';
    const qb = this.dataSource
      .getRepository(ClipEntity)
      .createQueryBuilder('clip')
      .where('clip.uca = :uca', { uca })
      .andWhere('clip.status = :status', { status });
    if (status === 'ready') {
      qb.andWhere('clip.expiresAt > :now', { now: Date.now() });
    }
    (['userId', 'trackId', 'source', 'category'] as const).forEach((field) => {
      if (data[field] !== undefined) {
        qb.andWhere(`clip.${field} = :${field}`, { [field]: data[field] });
      }
    });
    if (data.tag !== undefined) {
      // tags 以 JSON 数组保存，按带引号的元素匹配
      const escaped = JSON.stringify(data.tag).replace(/[\\%_]/g, (c) => `\\${c}`);
      qb.andWhere("clip.tags LIKE :tag ESCAPE '\\'", { tag: `%${escaped}%` });
    }
    if (data.createdAfter !== undefined) {
      qb.andWhere('clip.createdAt >= :createdAfter', { createdAfter: data.createdAfter });
    }
    if (data.createdBefore !== undefined) {
      qb.andWhere('clip.createdAt < :createdBefore', { createdBefore: data.createdBefore });
    }
    const [clips, total] = await qb
      .orderBy('clip.createdAt', 'DESC')
      .addOrderBy('clip.clipId', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return {
      clips: clips.map((clip) => this.toClipDTO(clip)),
      total,
      page,
      pageSize,
    };
  }

  public async getClipFile(uca: string, clipId: string, kind: 'media' | 'thumbnail'): Promise<ClipFileInfo> {
    const clip = await this.dataSource.getRepository(ClipEntity).findOne({ where: { uca, clipId } });
    if (!clip || clip.status !== 'ready' || clip.expiresAt <= Date.now()) {
      throw new ClipHttpException(404, ErrCode.ClipNotFound);
    }
    const relativePath = kind === 'media' ? clip.mediaPath : clip.thumbnailPath;
    const size = relativePath ? await this.statSize(this.absolute(relativePath)) : null;
    if (!relativePath || size === null) {
      throw new ClipHttpException(404, ErrCode.ClipNotFound);
    }
    return {
      path: this.absolute(relativePath),
      size,
      mimeType: kind === 'media' ? clip.mimeType : clip.thumbnailMimeType!,
      etag: kind === 'media' ? `"${clip.checksumSha256}"` : `"${clip.checksumSha256}-thumbnail"`,
    };
  }

  public createFileStream(filePath: string, start: number, end: number): Readable {
    return fs.createReadStream(filePath, { start, end });
  }

  public async deleteClip(uca: string, clipId: string): Promise<void> {
    const clip = await this.dataSource.getRepository(ClipEntity).findOne({ where: { uca, clipId } });
    if (!clip) {
      throw new LogicException(ErrCode.ClipNotFound);
    }
    if (clip.status === 'deleted') {
      return;
    }
    await this.write((m) => m.update(ClipEntity, clipId, { status: 'deleted', deletedAt: Date.now() }));
    this.socketIOServer.emitClipEvent(clip.uca, clip.category, clip.userId, 'clipDeleted', {
      clipId,
      status: 'deleted',
    });
    this.cleanup();
  }

  // ---------------------------------------------------------------------------
  // 保留与清理
  // ---------------------------------------------------------------------------

  /**
   * 到期处理与文件清理；清理失败在下一轮重试
   */
  public async cleanup() {
    if (this.cleaning) {
      return;
    }
    this.cleaning = true;
    try {
      const now = Date.now();
      const clipRepository = this.dataSource.getRepository(ClipEntity);
      const expiring = await clipRepository
        .createQueryBuilder('clip')
        .where('clip.status = :status', { status: 'ready' })
        .andWhere('clip.expiresAt <= :now', { now })
        .getMany();
      for (const clip of expiring) {
        await this.write(async (m) => {
          await m.update(ClipEntity, clip.clipId, { status: 'expired' });
          const remaining = await m.count(ClipEntity, { where: { taskId: clip.taskId, status: 'ready' } });
          if (remaining === 0) {
            await m.update(ClipTaskEntity, clip.taskId, { status: 'expired', updatedAt: now });
          }
        });
        this.socketIOServer.emitClipEvent(clip.uca, clip.category, clip.userId, 'clipDeleted', {
          clipId: clip.clipId,
          status: 'expired',
        });
      }

      const removable = await clipRepository.find({
        where: { status: In(['deleted', 'expired']), filesRemoved: false },
      });
      for (const clip of removable) {
        try {
          await fs.promises.rm(path.dirname(this.absolute(clip.mediaPath)), { recursive: true, force: true });
          await this.write((m) => m.update(ClipEntity, clip.clipId, { filesRemoved: true }));
        } catch (e) {
          console.error(`[clip] [cleanup] [${clip.uca}] remove files of clip ${clip.clipId} failed`, e);
        }
      }

      const staleUploads = await this.dataSource
        .getRepository(ClipUploadEntity)
        .createQueryBuilder('upload')
        .where('upload.status IN (:...statuses)', { statuses: ['created', 'uploading'] })
        .andWhere('upload.completePayload IS NULL')
        .andWhere('upload.expiresAt <= :now', { now })
        .getMany();
      for (const upload of staleUploads) {
        await this.write((m) => m.update(ClipUploadEntity, upload.uploadId, { status: 'expired', updatedAt: now }));
      }
      // 失败或过期会话的临时文件
      const deadUploads = await this.dataSource.getRepository(ClipUploadEntity).find({
        where: { status: In(['failed', 'expired']) },
      });
      await this.removeFiles(deadUploads.map((u) => this.uploadPath(u)));
    } catch (e) {
      console.error('[clip] cleanup failed', e);
    } finally {
      this.cleaning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 工具方法
  // ---------------------------------------------------------------------------

  /**
   * 所有写操作串行执行，每个写操作是一个事务（sqlite 驱动单连接，并发事务会交错）。
   * 回调内只能做数据库操作，不能等待文件或网络 IO
   */
  private write<T>(fn: (m: EntityManager) => Promise<T>): Promise<T> {
    const run = () => this.dataSource.transaction(fn);
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private withUploadLock<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.uploadLocks.get(uploadId) || Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.catch(() => undefined);
    this.uploadLocks.set(uploadId, tail);
    tail.then(() => {
      if (this.uploadLocks.get(uploadId) === tail) {
        this.uploadLocks.delete(uploadId);
      }
    });
    return result;
  }

  private checkItemToken(item: ClipTaskItemEntity, token: string, generation: number): 'ok' | 'invalid' | 'expired' {
    if (!token || item.generation !== generation || item.tokenHash !== sha256(token)) {
      return 'invalid';
    }
    return (item.tokenExpiresAt || 0) > Date.now() ? 'ok' : 'expired';
  }

  /**
   * 原生上传接口鉴权：凭证无效 401，过期或会话失效 410
   */
  private async authorizeUpload(uca: string, token: string, uploadId: string) {
    const upload = await this.dataSource.getRepository(ClipUploadEntity).findOne({ where: { uca, uploadId } });
    if (!upload) {
      throw new ClipHttpException(404, ErrCode.ClipUploadNotFound);
    }
    const item = await this.dataSource.getRepository(ClipTaskItemEntity).findOneByOrFail({ itemId: upload.itemId });
    const result = this.checkItemToken(item, token, upload.generation);
    if (result === 'invalid') {
      throw new ClipHttpException(401, ErrCode.ClipUploadExpired);
    }
    if (result === 'expired' || ['failed', 'expired'].includes(upload.status)) {
      throw new ClipHttpException(410, ErrCode.ClipUploadExpired);
    }
    return { upload, item };
  }

  /**
   * 已用存储：未清理切片文件 + 活动上传声明长度
   */
  private async getUsedStorageBytes(m: EntityManager) {
    const clips = await m
      .createQueryBuilder(ClipEntity, 'clip')
      .select('COALESCE(SUM(clip.byteSize), 0)', 'total')
      .where('clip.filesRemoved = :removed', { removed: false })
      .getRawOne();
    const uploads = await m
      .createQueryBuilder(ClipUploadEntity, 'upload')
      .select('COALESCE(SUM(upload.uploadLength), 0)', 'total')
      .where('upload.status IN (:...statuses)', { statuses: ['created', 'uploading'] })
      .getRawOne();
    return Number(clips.total) + Number(uploads.total);
  }

  /**
   * 比赛结束时间，无法获取时使用 fallback
   */
  private async getContestEndTime(uca: string, fallback: number) {
    try {
      const contest = (await this.liveContestService.findContestByAlias(uca))?.contest;
      if (!contest) {
        return fallback;
      }
      const end = new Date(contest.startAt).getTime() + this.miscUtils.formatTimeDuration(contest.duration, 'ms');
      return Number.isFinite(end) ? end : fallback;
    } catch (e) {
      return fallback;
    }
  }

  private async notifyTask(taskId: string): Promise<ClipTaskDTO> {
    const task = await this.dataSource.getRepository(ClipTaskEntity).findOneByOrFail({ taskId });
    const dto = await this.toTaskDTO(task);
    this.socketIOServer.emitClipEvent(task.uca, task.category, task.userId, 'clipTaskUpdated', { task: dto });
    return dto;
  }

  private async toTaskDTO(task: ClipTaskEntity): Promise<ClipTaskDTO> {
    return (await this.toTaskDTOs([task]))[0];
  }

  private async toTaskDTOs(tasks: ClipTaskEntity[]): Promise<ClipTaskDTO[]> {
    if (tasks.length === 0) {
      return [];
    }
    const taskIds = tasks.map((t) => t.taskId);
    const [items, uploads, clips] = await Promise.all([
      this.dataSource
        .getRepository(ClipTaskItemEntity)
        .find({ where: { taskId: In(taskIds) }, order: { createdAt: 'ASC' } }),
      this.dataSource
        .getRepository(ClipUploadEntity)
        .find({ where: { taskId: In(taskIds), role: 'media' }, order: { createdAt: 'ASC' } }),
      this.dataSource.getRepository(ClipEntity).find({ where: { taskId: In(taskIds) } }),
    ]);
    return tasks.map((task) => {
      const taskItems = items.filter((i) => i.taskId === task.taskId);
      return {
        taskId: task.taskId,
        uca: task.uca,
        source: task.source,
        title: task.title,
        category: task.category,
        tags: task.tags,
        priority: task.priority,
        userId: task.userId,
        status: task.status,
        startServerMs: task.startServerMs,
        endServerMs: task.endServerMs,
        attempts: Math.max(0, ...taskItems.map((i) => i.attempts)),
        maxAttempts: task.maxAttempts,
        progress: task.progress,
        errorCode: task.errorCode || undefined,
        errorMessage: task.errorMessage || undefined,
        items: taskItems.map((item) => ({
          itemId: item.itemId,
          taskId: item.taskId,
          uca: item.uca,
          userId: item.userId,
          trackId: item.trackId,
          status: item.status,
          uploadId: uploads.filter((u) => u.itemId === item.itemId).pop()?.uploadId,
          clipId: clips.find((c) => c.itemId === item.itemId)?.clipId,
          progress: item.progress,
          errorCode: item.errorCode || undefined,
          errorMessage: item.errorMessage || undefined,
          actualStartServerMs: item.actualStartServerMs ?? undefined,
          actualEndServerMs: item.actualEndServerMs ?? undefined,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
        createdClipIds: clips.filter((c) => c.taskId === task.taskId).map((c) => c.clipId),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        expiresAt: task.expiresAt,
      };
    });
  }

  private toClipDTO(clip: ClipEntity): ClipDTO {
    return {
      clipId: clip.clipId,
      uca: clip.uca,
      taskId: clip.taskId,
      itemId: clip.itemId,
      userId: clip.userId,
      trackId: clip.trackId,
      source: clip.source,
      category: clip.category,
      title: clip.title,
      tags: clip.tags,
      mimeType: clip.mimeType,
      byteSize: clip.byteSize,
      durationMs: clip.durationMs,
      width: clip.width ?? undefined,
      height: clip.height ?? undefined,
      videoCodec: clip.videoCodec ?? undefined,
      audioCodec: clip.audioCodec ?? undefined,
      checksumSha256: clip.checksumSha256,
      actualStartServerMs: clip.actualStartServerMs,
      actualEndServerMs: clip.actualEndServerMs,
      thumbnailUrl: clip.thumbnailPath ? `/api/clips/${clip.clipId}/thumbnail` : undefined,
      mediaUrl: `/api/clips/${clip.clipId}/media`,
      status: clip.status,
      createdAt: clip.createdAt,
      expiresAt: clip.expiresAt,
    };
  }

  private uploadPath(upload: ClipUploadEntity) {
    return this.absolute(`${encodeURIComponent(upload.uca)}/uploads/${upload.uploadId}.part`);
  }

  /**
   * 正式文件相对存储根的路径
   */
  private clipFilePath(uca: string, clipId: string, name: 'media' | 'thumbnail', mimeType: string) {
    return `${encodeURIComponent(uca)}/clips/${clipId}/${name}.${FILE_EXTENSIONS[mimeType]}`;
  }

  private absolute(relativePath: string) {
    return path.join(this.clipConfig.storageDir, relativePath);
  }

  /** 临时文件存在则用临时文件，否则用正式文件（重启前已移动） */
  private async existingPath(tempPath: string, finalPath: string) {
    return (await this.statSize(tempPath)) !== null ? tempPath : finalPath;
  }

  private async moveIntoPlace(from: string, to: string) {
    if ((await this.statSize(from)) === null) {
      return;
    }
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.rename(from, to);
  }

  private async statSize(filePath: string): Promise<number | null> {
    try {
      return (await fs.promises.stat(filePath)).size;
    } catch (e) {
      return null;
    }
  }

  private async removeFiles(paths: (string | null | undefined)[]) {
    for (const p of paths) {
      if (p) {
        await fs.promises.rm(p, { force: true }).catch(() => undefined);
      }
    }
  }
}

const FILE_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * 按文件头识别图片格式
 */
async function sniffImage(filePath: string): Promise<string | null> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { buffer } = await fh.read(Buffer.alloc(12), 0, 12, 0);
    if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
      return 'image/png';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'image/jpeg';
    }
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      return 'image/webp';
    }
    return null;
  } finally {
    await fh.close();
  }
}
