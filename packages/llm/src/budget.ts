/**
 * 流水线共享的 token 硬预算器（方案 3.3）。
 * 全流水线共享一个实例；预算耗尽时未审查的低优先级文件自动降级为 staticOnly，
 * 并在报告中标注"预算受限，已降级"。
 *
 * 关键不变量：预留（reserve）必须在调用结束后结算（account）或释放（release），
 * 否则预算只增不减，会误把后续文件全部降级（历史缺陷）。
 */
export class TokenBudget {
  private used = 0;
  /** 尚未由真实 usage 抵扣的预留估算，保证并行/多文件审查不会突破上限。 */
  private reserved = 0;

  constructor(
    private readonly max: number,
    private readonly onExhausted?: () => void,
  ) {}

  /**
   * 预留估算额度；余额不足时触发 onExhausted 回调并拒绝。
   * @param estimate 本次调用的预估 token 消耗
   * @returns 是否允许消耗
   */
  public tryReserve(estimate: number): boolean {
    if (estimate < 0 || this.used + this.reserved + estimate > this.max) {
      this.onExhausted?.();
      return false;
    }
    this.reserved += estimate;
    return true;
  }

  /**
   * 释放未被真实用量抵扣的预留（调用失败/取消/跳过时使用）。
   * @param estimate 之前预留的估算值
   */
  public release(estimate: number): void {
    if (estimate <= 0) return;
    this.reserved = Math.max(0, this.reserved - estimate);
  }

  /**
   * 按真实用量记账（Provider usage）。真实用量会优先抵扣未结算的估算预留。
   * @param usage 模型返回的 usage
   */
  public account(usage: { totalTokens: number }): void {
    if (usage.totalTokens < 0) return;
    this.used += usage.totalTokens;
    this.reserved = Math.max(0, this.reserved - usage.totalTokens);
  }

  /** 已消耗/已预留比例（0-1），供报告与 Dashboard 展示 */
  public get usageRatio(): number {
    return Math.min(1, (this.used + this.reserved) / this.max);
  }

  /** 预算快照（报告与可观测页展示成本构成） */
  public snapshot(): { used: number; reserved: number; max: number; ratio: number } {
    return { used: this.used, reserved: this.reserved, max: this.max, ratio: this.usageRatio };
  }
}
