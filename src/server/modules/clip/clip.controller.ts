import {
  Contract,
  Data,
  Delete,
  Get,
  Head,
  Header,
  InjectCtx,
  Patch,
  Post,
  RequestContext,
  UseGuards,
} from 'bwcx-ljsm';
import { Inject } from 'bwcx-core';
import { ApiController, Uca } from '@server/decorators';
import AuthGuard from '@server/guards/auth.guard';
import { CustomResponse } from '@server/response-handlers/custom.response-handler';
import LogicException from '@server/exceptions/logic.exception';
import ClipHttpException from '@server/exceptions/clip-http.exception';
import { ErrCode } from '@common/enums/err-code.enum';
import {
  ClipParamReqDTO,
  ClipUploadParamReqDTO,
  CompleteClipUploadReqDTO,
  CompleteClipUploadRespDTO,
  CreateClipTaskReqDTO,
  CreateClipTaskRespDTO,
  CreateClipUploadReqDTO,
  CreateClipUploadRespDTO,
  DeleteClipRespDTO,
  GetClipTaskReqDTO,
  GetClipTaskRespDTO,
  ListClipsReqDTO,
  ListClipsRespDTO,
  ListClipTasksReqDTO,
  ListClipTasksRespDTO,
  ReportClipTaskProgressReqDTO,
  ReportClipTaskProgressRespDTO,
} from '@common/modules/clip/clip.dto';
import ClipConfig from '@server/configs/clip/clip.config';
import ClipService from './clip.service';

@ApiController('/clips')
export default class ClipController {
  public constructor(
    @InjectCtx()
    private readonly ctx: RequestContext,

    @Inject()
    private readonly service: ClipService,

    @Inject()
    private readonly clipConfig: ClipConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // 切片任务（导播）
  // ---------------------------------------------------------------------------

  @Post('/tasks')
  @UseGuards(AuthGuard)
  @Contract(CreateClipTaskReqDTO, CreateClipTaskRespDTO)
  public async createTask(@Uca() uca: string, @Data() data: CreateClipTaskReqDTO): Promise<CreateClipTaskRespDTO> {
    const { startServerMs, endServerMs } = data;
    if (
      endServerMs <= startServerMs ||
      endServerMs > Date.now() ||
      endServerMs - startServerMs > this.clipConfig.maxDurationMs
    ) {
      throw new LogicException(ErrCode.ClipTaskInvalidTimeWindow);
    }
    if (data.maxAttempts !== undefined && data.maxAttempts > this.clipConfig.taskMaxAttempts) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    return {
      task: await this.service.createTask(uca, data),
    };
  }

  @Get('/tasks')
  @UseGuards(AuthGuard)
  @Contract(ListClipTasksReqDTO, ListClipTasksRespDTO)
  public async listTasks(@Uca() uca: string, @Data() data: ListClipTasksReqDTO): Promise<ListClipTasksRespDTO> {
    return this.service.listTasks(uca, data);
  }

  @Get('/tasks/:taskId')
  @UseGuards(AuthGuard)
  @Contract(GetClipTaskReqDTO, GetClipTaskRespDTO)
  public async getTask(@Uca() uca: string, @Data() data: GetClipTaskReqDTO): Promise<GetClipTaskRespDTO> {
    return {
      task: await this.service.getTask(uca, data.taskId),
    };
  }

  // ---------------------------------------------------------------------------
  // 进度与上传（选手，X-Upload-Token）
  // ---------------------------------------------------------------------------

  @Post('/tasks/:taskId/progress')
  @Contract(ReportClipTaskProgressReqDTO, ReportClipTaskProgressRespDTO)
  public async reportProgress(
    @Uca() uca: string,
    @Header('x-upload-token') token: string,
    @Data() data: ReportClipTaskProgressReqDTO,
  ): Promise<ReportClipTaskProgressRespDTO> {
    return {
      task: await this.service.reportProgress(uca, token, data),
    };
  }

  @Post('/tasks/:taskId/uploads')
  @Contract(CreateClipUploadReqDTO, CreateClipUploadRespDTO)
  public async createUpload(
    @Uca() uca: string,
    @Header('x-upload-token') token: string,
    @Data() data: CreateClipUploadReqDTO,
  ): Promise<CreateClipUploadRespDTO> {
    const isMedia = data.role === 'media';
    if (isMedia !== data.mimeType.startsWith('video/')) {
      throw new LogicException(ErrCode.IllegalParameters);
    }
    const maxBytes = isMedia ? this.clipConfig.maxUploadBytes : this.clipConfig.maxThumbnailBytes;
    if (data.uploadLength > maxBytes) {
      throw new LogicException(ErrCode.ClipStorageQuotaExceeded);
    }
    return this.service.createUpload(uca, token, data);
  }

  @Head('/uploads/:uploadId')
  @CustomResponse()
  @Contract(ClipUploadParamReqDTO, null)
  public async headUpload(
    @Uca() uca: string,
    @Header('x-upload-token') token: string,
    @Data() data: ClipUploadParamReqDTO,
  ) {
    const upload = await this.service.getUploadState(uca, token, data.uploadId);
    this.ctx.status = 204;
    this.ctx.set('Cache-Control', 'no-store');
    this.ctx.set('Upload-Offset', `${upload.offset}`);
    this.ctx.set('Upload-Length', `${upload.length}`);
    this.ctx.set('Upload-Expires', new Date(upload.expiresAt).toUTCString());
  }

  @Patch('/uploads/:uploadId')
  @CustomResponse()
  @Contract(ClipUploadParamReqDTO, null)
  public async patchUpload(
    @Uca() uca: string,
    @Header('x-upload-token') token: string,
    @Data() data: ClipUploadParamReqDTO,
  ) {
    const offset = parseInt(this.ctx.get('Upload-Offset'), 10);
    const length = parseInt(this.ctx.get('Content-Length'), 10);
    if (this.ctx.get('Content-Type') !== 'application/offset+octet-stream' || !(offset >= 0) || !(length > 0)) {
      throw new ClipHttpException(400, ErrCode.IllegalParameters);
    }
    // bodyparser 不解析 offset+octet-stream，请求体保留在 ctx.req 中流式读取
    const newOffset = await this.service.appendUpload(uca, token, data.uploadId, offset, length, this.ctx.req);
    this.ctx.status = 204;
    this.ctx.set('Cache-Control', 'no-store');
    this.ctx.set('Upload-Offset', `${newOffset}`);
  }

  @Post('/uploads/:uploadId/complete')
  @Contract(CompleteClipUploadReqDTO, CompleteClipUploadRespDTO)
  public async completeUpload(
    @Uca() uca: string,
    @Header('x-upload-token') token: string,
    @Data() data: CompleteClipUploadReqDTO,
  ): Promise<CompleteClipUploadRespDTO> {
    return this.service.completeUpload(uca, token, data);
  }

  // ---------------------------------------------------------------------------
  // 切片消费（导播）
  // ---------------------------------------------------------------------------

  @Get('/')
  @UseGuards(AuthGuard)
  @Contract(ListClipsReqDTO, ListClipsRespDTO)
  public async listClips(@Uca() uca: string, @Data() data: ListClipsReqDTO): Promise<ListClipsRespDTO> {
    return this.service.listClips(uca, data);
  }

  @Get('/:clipId/thumbnail')
  @UseGuards(AuthGuard)
  @CustomResponse()
  @Contract(ClipParamReqDTO, null)
  public async getThumbnail(@Uca() uca: string, @Data() data: ClipParamReqDTO) {
    return this.sendClipFile(uca, data.clipId, 'thumbnail');
  }

  @Head('/:clipId/media')
  @UseGuards(AuthGuard)
  @CustomResponse()
  @Contract(ClipParamReqDTO, null)
  public async headMedia(@Uca() uca: string, @Data() data: ClipParamReqDTO) {
    return this.sendClipFile(uca, data.clipId, 'media');
  }

  @Get('/:clipId/media')
  @UseGuards(AuthGuard)
  @CustomResponse()
  @Contract(ClipParamReqDTO, null)
  public async getMedia(@Uca() uca: string, @Data() data: ClipParamReqDTO) {
    return this.sendClipFile(uca, data.clipId, 'media');
  }

  @Delete('/:clipId')
  @UseGuards(AuthGuard)
  @Contract(ClipParamReqDTO, DeleteClipRespDTO)
  public async deleteClip(@Uca() uca: string, @Data() data: ClipParamReqDTO): Promise<DeleteClipRespDTO> {
    await this.service.deleteClip(uca, data.clipId);
    return {
      clipId: data.clipId,
      status: 'deleted',
    };
  }

  /**
   * 输出切片文件，支持完整读取与单段 Range（a-b、a-、-n），多段或越界返回 416
   */
  private async sendClipFile(uca: string, clipId: string, kind: 'media' | 'thumbnail') {
    const file = await this.service.getClipFile(uca, clipId, kind);
    this.ctx.set('Content-Type', file.mimeType);
    this.ctx.set('Accept-Ranges', 'bytes');
    this.ctx.set('ETag', file.etag);
    this.ctx.set('Cache-Control', 'private, no-store');

    let start = 0;
    let end = file.size - 1;
    const range = this.ctx.get('Range');
    const ifRange = this.ctx.get('If-Range');
    const useRange = !!range && (!ifRange || ifRange === file.etag);
    if (useRange) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match?.[1]) {
        start = parseInt(match[1], 10);
        end = match[2] ? Math.min(parseInt(match[2], 10), file.size - 1) : file.size - 1;
      } else if (match && parseInt(match[2], 10) > 0) {
        start = Math.max(file.size - parseInt(match[2], 10), 0);
      } else {
        start = file.size;
      }
      if (start > end) {
        throw new ClipHttpException(416, ErrCode.ClipMediaRangeNotSatisfiable, {
          'Content-Range': `bytes */${file.size}`,
        });
      }
      this.ctx.set('Content-Range', `bytes ${start}-${end}/${file.size}`);
    }
    this.ctx.status = useRange ? 206 : 200;
    this.ctx.length = end - start + 1;
    if (this.ctx.method === 'HEAD') {
      return;
    }
    return this.service.createFileStream(file.path, start, end);
  }
}
