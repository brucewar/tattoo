import { HttpException } from '@nestjs/common';

const windowMilliseconds = 15 * 60 * 1000;

export class LoginRateLimiter {
  private readonly attempts = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity = 10000,
  ) {}

  consume(key: string) {
    const now = this.now();
    let entry = this.attempts.get(key);
    if (entry && entry.startedAt + windowMilliseconds <= now) {
      this.attempts.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (this.attempts.size >= this.capacity) {
        for (const [storedKey, attempt] of this.attempts) {
          if (attempt.startedAt + windowMilliseconds <= now) this.attempts.delete(storedKey);
        }
      }
      if (this.attempts.size >= this.capacity) this.reject();
      entry = { startedAt: now, count: 0 };
      this.attempts.set(key, entry);
    }
    if (entry.count >= 5) this.reject();
    entry.count++;
  }

  clear(key: string) {
    this.attempts.delete(key);
  }

  private reject(): never {
    throw new HttpException('登录尝试过于频繁，请稍后再试', 429);
  }
}
