import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * Attaches request.user when a valid token is present, but never rejects.
 * Used on public reads that still need to know the viewer — e.g. whether
 * they've already liked a post.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      try {
        request.user = this.jwtService.verify(authHeader.split(' ')[1]);
      } catch {
        request.user = undefined;
      }
    }

    return true;
  }
}
