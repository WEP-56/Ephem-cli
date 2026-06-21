// 简单的滑动窗口限流器。
// 作为 RoomObject 的实例字段使用，因此限流作用域是单个房间（单个 DO 实例）。

export class RateLimiter {
  private attempts = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /**
   * 记录一次尝试。返回 true 表示放行，false 表示超出限额被限流。
   */
  check(key: string): boolean {
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter(
      (t) => now - t < this.windowMs,
    );
    if (recent.length >= this.max) {
      this.attempts.set(key, recent);
      return false;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    return true;
  }
}
