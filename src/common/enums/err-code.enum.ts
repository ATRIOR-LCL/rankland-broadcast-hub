export enum ErrCode {
  /** 未捕获异常 */
  SystemError = -1,
  /** 非法请求 */
  IllegalRequest = -2,
  /** 非法参数 */
  IllegalParameters = -3,
  /** 未授权 */
  Unauthorized = -4,
  /** 无效的授权信息 */
  InvalidAuthInfo = -5,

  // LiveContest
  LiveContestExisted = 100000,
  LiveContestNotFound = 100001,
  LiveContestMemberNotFound = 100002,

  // Broadcast
  BroadcastNotReady = 200000,
  BroadcastMediaRoomBroken = 200001,
  BroadcastMediaRoomPeerMissing = 200002,
  BroadcastMediaRoomRequiredTrackMissing = 200003,
  BroadcastMediaRoomCannotConsume = 200004,

  // Clip
  ClipTaskNotFound = 300010,
  ClipTaskInvalidTimeWindow = 300011,
  ClipUploadNotFound = 300020,
  ClipUploadOffsetMismatch = 300021,
  ClipUploadExpired = 300023,
  ClipUploadConflict = 300024,
  ClipUploadInvalidState = 300025,
  ClipStorageQuotaExceeded = 300026,
  ClipMediaValidationFailed = 300030,
  ClipNotFound = 300040,
  ClipMediaRangeNotSatisfiable = 300041,
}
