import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@signal-face/db';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Attempts before giving up, and the ceiling on the exponential backoff.
   *
   * Sized for a managed database that flaps rather than one that is simply
   * absent: 1s, 2s, 4s, 8s then 10s a go adds up to ~65s of waiting, and with
   * each attempt's own connect timeout on top the service rides out roughly two
   * minutes of unavailability before it exits.
   *
   * It does still exit. Failing after two minutes is deliberate — a process that
   * boots without a database only turns one loud error into a hundred quiet ones
   * on the first request. Restarting is the supervisor's job.
   */
  private static readonly MAX_ATTEMPTS = 10;
  private static readonly MAX_BACKOFF_MS = 10_000;

  async onModuleInit() {
    const { MAX_ATTEMPTS, MAX_BACKOFF_MS } = PrismaService;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.$connect();
        this.logger.log('✅ Database connected');
        return;
      } catch (err) {
        // The reason matters as much as the failure: an unreachable host is
        // somebody else's outage, bad credentials are ours to fix, and the two
        // look identical if all we log is "failed".
        const reason = err instanceof Error ? err.message.split('\n').find((l) => l.trim()) : String(err);

        if (attempt === MAX_ATTEMPTS) {
          this.logger.error(
            `Database unreachable after ${MAX_ATTEMPTS} attempts, giving up: ${reason}`,
          );
          throw err;
        }

        const delayMs = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        this.logger.warn(
          `Database connection attempt ${attempt}/${MAX_ATTEMPTS} failed ` +
            `(${reason}), retrying in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }
}
