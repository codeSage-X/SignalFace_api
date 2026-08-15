import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Blocks writes from an account that is under review or banned.
 *
 * Reading stays open — a restricted user can still browse, which is the point of
 * "under review" as opposed to a ban. Only the routes that publish or interact
 * carry this guard, so the check costs one lookup on write paths and nothing on
 * the read paths that make up most of the traffic.
 *
 * Must be listed after JwtAuthGuard, which is what puts `user` on the request.
 */
@Injectable()
export class ActiveAccountGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.sub;

    // No session is JwtAuthGuard's business, not this guard's.
    if (!userId) return true;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { accountStatus: true, statusReason: true },
    });

    // Deleted mid-session: nothing left to authorise.
    if (!user) {
      throw new ForbiddenException({
        code: 'ACCOUNT_MISSING',
        message: 'This account no longer exists.',
      });
    }

    if (user.accountStatus === 'BLOCKED') {
      throw new ForbiddenException({
        code: 'ACCOUNT_BLOCKED',
        message: user.statusReason
          ? `This account has been blocked: ${user.statusReason}`
          : 'This account has been blocked.',
      });
    }

    if (user.accountStatus === 'RESTRICTED') {
      throw new ForbiddenException({
        code: 'ACCOUNT_RESTRICTED',
        message: user.statusReason
          ? `Your account is under review: ${user.statusReason}`
          : 'Your account is under review, so you cannot post or interact right now.',
      });
    }

    return true;
  }
}
