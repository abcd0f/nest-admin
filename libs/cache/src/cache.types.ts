/** 允许写入 Redis 的 JSON 值；undefined、Date、Map、类和循环引用都会被拒绝。 */
export type CacheValue =
  | string
  | number
  | boolean
  | null
  | CacheValue[]
  | { [key: string]: CacheValue };

/** 进程内累计的缓存指标，用于健康检查、日志和后续接入指标系统。 */
export interface CacheMetrics {
  /** get/getMany/wrap 命中次数 */
  hits: number;
  /** get/getMany/wrap 未命中次数 */
  misses: number;
  /** 成功写入次数 */
  sets: number;
  /** 实际删除的键数量 */
  deletes: number;
  /** 读取命令失败次数（按未命中降级） */
  readErrors: number;
  /** 写入命令失败次数 */
  writeErrors: number;
  /** 删除命令失败次数 */
  deleteErrors: number;
  /** 值解码失败次数（按未命中降级） */
  decodeErrors: number;
  /** 被进程内 single-flight 合并的并发加载次数 */
  coalesced: number;
}
