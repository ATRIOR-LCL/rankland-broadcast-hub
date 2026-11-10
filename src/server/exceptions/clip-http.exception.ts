import { Exception } from 'bwcx-ljsm';
import type { ErrCode } from '@common/enums/err-code.enum';

/**
 * 精彩回放原生接口（上传 HEAD/PATCH、媒体与缩略图读取）的错误，返回 HTTP 状态码且无 JSON 正文
 */
export default class ClipHttpException extends Exception {
  public status: number;
  public code: ErrCode;
  public headers: Record<string, string>;

  public constructor(status: number, code: ErrCode, headers: Record<string, string> = {}) {
    super(`Clip HTTP error ${status} (${code})`);
    this.name = 'ClipHttpException';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
