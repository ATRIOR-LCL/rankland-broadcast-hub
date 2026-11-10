import { ExceptionHandler } from 'bwcx-ljsm';
import type { IBwcxExceptionHandler, RequestContext } from 'bwcx-ljsm';
import ClipHttpException from '@server/exceptions/clip-http.exception';

@ExceptionHandler(ClipHttpException)
export default class ClipHttpExceptionHandler implements IBwcxExceptionHandler {
  public catch(e: ClipHttpException, ctx: RequestContext) {
    ctx.warn(`ClipHttpException caught: ${e.status} ${e.code}`);
    ctx.status = e.status;
    ctx.set('X-Clip-Error-Code', `${e.code}`);
    Object.keys(e.headers).forEach((key) => ctx.set(key, e.headers[key]));
    // 不能设为 null，否则 Koa 会把状态改写为 204
    ctx.body = '';
  }
}
