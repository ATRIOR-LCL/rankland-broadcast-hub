import { registerErrCodeConfigs } from '@server/err-code-configs';
import { ErrCode } from '@common/enums/err-code.enum';

registerErrCodeConfigs({
  [ErrCode.SystemError]: '系统异常，请稍后再试',
  [ErrCode.IllegalRequest]: '非法请求',
  [ErrCode.IllegalParameters]: '非法参数',
  [ErrCode.Unauthorized]: '未授权的操作',
  [ErrCode.InvalidAuthInfo]: '未能授权，因为提供的信息错误',

  // LiveContest
  [ErrCode.LiveContestExisted]: '该比赛已存在',
  [ErrCode.LiveContestNotFound]: '该比赛未找到',
  [ErrCode.LiveContestMemberNotFound]: '该比赛成员未找到',

  // Broadcast
  [ErrCode.BroadcastNotReady]: '推流未就绪',
  [ErrCode.BroadcastMediaRoomBroken]: '推流媒体房间未知异常',
  [ErrCode.BroadcastMediaRoomPeerMissing]: '推流媒体房间 Peer 信息丢失',
  [ErrCode.BroadcastMediaRoomRequiredTrackMissing]: '所请求的推流轨道信息丢失',
  [ErrCode.BroadcastMediaRoomCannotConsume]: '无法消费所请求的推流轨道',

  // Clip
  [ErrCode.ClipTaskNotFound]: '切片任务不存在',
  [ErrCode.ClipTaskInvalidTimeWindow]: '切片时间窗非法',
  [ErrCode.ClipUploadNotFound]: '上传会话不存在',
  [ErrCode.ClipUploadOffsetMismatch]: '上传偏移不一致',
  [ErrCode.ClipUploadExpired]: '上传凭证无效或已过期',
  [ErrCode.ClipUploadConflict]: '上传声明与已有会话冲突',
  [ErrCode.ClipUploadInvalidState]: '当前上传状态不允许该操作',
  [ErrCode.ClipStorageQuotaExceeded]: '超出切片大小或存储容量上限',
  [ErrCode.ClipMediaValidationFailed]: '媒体校验失败',
  [ErrCode.ClipNotFound]: '切片不存在',
  [ErrCode.ClipMediaRangeNotSatisfiable]: '请求范围无法满足',
});
