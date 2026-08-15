import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomInt, randomBytes, createHash } from 'crypto';
import {
  EMAIL_OTP_TTL_MINUTES,
  PASSWORD_RESET_OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  REFRESH_TOKEN_TTL_DAYS,
} from '@signal-face/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { FirebaseService } from '../firebase/firebase.service';
import { RewardsService } from '../rewards/rewards.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyResetOtpDto } from './dto/verify-reset-otp.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import type { User, AuthTokenType } from '@signal-face/db';

/** How long a just-rotated refresh token still works. See `refresh`. */
const REFRESH_REUSE_GRACE_MS = 30_000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly firebase: FirebaseService,
    // forwardRef because RewardsModule needs AuthModule's guards, and this needs
    // RewardsService to pay the referral bonus — the two genuinely depend on
    // each other.
    @Inject(forwardRef(() => RewardsService))
    private readonly rewards: RewardsService,
  ) {}

  async register(dto: RegisterDto) {
    // The DTO already lowercased this, but normalise again so the check can
    // never diverge from what gets written — that mismatch was letting a
    // mixed-case name pass the lookup and then fail on the unique index.
    const username = dto.username.trim().toLowerCase();

    const [emailTaken, usernameTaken] = await Promise.all([
      this.prisma.user.findUnique({ where: { email: dto.email } }),
      this.prisma.user.findUnique({ where: { username } }),
    ]);

    if (emailTaken) {
      throw new ConflictException('An account with this email already exists');
    }
    if (usernameTaken) {
      throw new ConflictException('That username is already taken');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    // Resolve the inviter now, but pay nothing yet — the bonus lands when this
    // account verifies, so an abandoned sign-up is never worth money.
    let referredById: string | null = null;
    if (dto.referralCode?.trim()) {
      const referrer = await this.prisma.user.findUnique({
        where: { referralCode: dto.referralCode.trim() },
        select: { id: true },
      });
      referredById = referrer?.id ?? null;
    }

    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          username,
          displayName: `${dto.firstName} ${dto.lastName}`,
          dateOfBirth: new Date(dto.dateOfBirth),
          gender: dto.gender,
          referredById,
        },
      });
    } catch (err: any) {
      // Two people can clear the check above at the same moment and race to the
      // insert. The unique index is what actually decides it, so translate its
      // rejection into the same message rather than a 500.
      if (err?.code === 'P2002') {
        const target = String(err?.meta?.target ?? '');
        throw new ConflictException(
          target.includes('email')
            ? 'An account with this email already exists'
            : 'That username is already taken',
        );
      }
      throw err;
    }

    await this.issueOtp(user, 'EMAIL_VERIFY');

    return {
      email: user.email,
      message: 'Account created. Enter the code we emailed you to verify your account.',
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // OAuth-only accounts have no password to compare against.
    if (!user.passwordHash) {
      throw new UnauthorizedException({
        code: 'OAUTH_ACCOUNT',
        message: 'This account uses Google sign-in. Continue with Google instead.',
      });
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.emailVerified) {
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email before logging in.',
      });
    }

    this.assertNotBlocked(user);

    return { ...(await this.issueSession(user)), user: this.sanitize(user) };
  }

  async googleAuth(dto: GoogleAuthDto) {
    const identity = await this.firebase.verifyIdToken(dto.idToken);

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ firebaseUid: identity.uid }, { email: identity.email }] },
    });

    if (existing) {
      // A ban has to hold whichever door they come through.
      this.assertNotBlocked(existing);

      // Same person arriving by Google for the first time on an email/password account:
      // Firebase already proved they control the address, so linking is safe.
      const user =
        existing.firebaseUid === identity.uid && existing.emailVerified
          ? existing
          : await this.prisma.user.update({
              where: { id: existing.id },
              data: {
                firebaseUid: identity.uid,
                authProvider: existing.authProvider ?? identity.provider,
                emailVerified: true,
                avatarUrl: existing.avatarUrl ?? identity.picture,
              },
            });

      return {
        ...(await this.issueSession(user)),
        user: this.sanitize(user),
        isNewUser: false,
      };
    }

    const [firstName, ...rest] = (identity.name ?? identity.email.split('@')[0]).trim().split(/\s+/);
    const lastName = rest.join(' ');

    const user = await this.prisma.user.create({
      data: {
        email: identity.email,
        firebaseUid: identity.uid,
        authProvider: identity.provider,
        emailVerified: true,
        firstName: firstName || 'Signal',
        lastName: lastName || 'User',
        username: await this.generateUsername(identity.email),
        displayName: identity.name ?? identity.email.split('@')[0],
        avatarUrl: identity.picture,
      },
    });

    return {
      ...(await this.issueSession(user)),
      user: this.sanitize(user),
      isNewUser: true,
    };
  }

  // Google gives us no username, so derive one from the email and settle collisions
  // with a numeric suffix. Bounded so a pathological run of taken names can't spin forever.
  private async generateUsername(email: string) {
    const base =
      email
        .split('@')[0]
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '')
        .slice(0, 20) || 'user';

    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = attempt === 0 ? base : `${base}${randomInt(1000, 10_000)}`;
      const taken = await this.prisma.user.findUnique({ where: { username: candidate } });
      if (!taken) return candidate;
    }

    return `${base}${randomInt(100_000_000, 1_000_000_000)}`;
  }

  async verifyEmail(dto: VerifyEmailDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      throw new BadRequestException('Invalid or expired code');
    }

    await this.consumeOtp(user, 'EMAIL_VERIFY', dto.otp);

    const verifiedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });

    // The referrer is paid here rather than at registration, so an account that
    // never verifies is never worth anything — otherwise the bonus is farmable
    // with throwaway addresses. Best effort: a payout problem must not stop
    // someone verifying their own account.
    if (verifiedUser.referredById) {
      try {
        await this.rewards.creditReferral(verifiedUser.referredById, verifiedUser.id);
      } catch {
        // Swallowed deliberately; the claim is idempotent per invited account,
        // so it can be retried without double-paying.
      }
    }

    return {
      ...(await this.issueSession(verifiedUser)),
      user: this.sanitize(verifiedUser),
    };
  }

  async resendOtp(dto: ResendOtpDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (user && !user.emailVerified) {
      await this.issueOtp(user, 'EMAIL_VERIFY');
    }
    return { message: 'If that email needs verifying, a new code has been sent.' };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (user) {
      await this.issueOtp(user, 'PASSWORD_RESET');
    }
    return { message: 'If that email is registered, a reset code has been sent.' };
  }

  async verifyResetOtp(dto: VerifyResetOtpDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      throw new BadRequestException('Invalid or expired code');
    }

    await this.consumeOtp(user, 'PASSWORD_RESET', dto.otp, false);

    return { message: 'Code verified.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      throw new BadRequestException('Invalid or expired code');
    }

    await this.consumeOtp(user, 'PASSWORD_RESET', dto.otp);

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    // Whoever changed the password now owns the account — any session opened
    // before this point (including an attacker's) must not survive it.
    await this.revokeAllRefreshTokens(user.id);

    return { ...(await this.issueSession(updated)), user: this.sanitize(updated) };
  }

  /**
   * Trades a valid refresh token for a fresh pair, rotating single-use so a
   * leaked copy stops working as soon as the real client renews.
   *
   * Rotation is relaxed by a short grace window: two tabs, or a retried request,
   * can legitimately present the same token at nearly the same moment, and
   * failing the loser would log the user out for no reason — the exact failure
   * this change exists to remove. Within the window the token yields a second
   * independent session instead; a thief still only gets those few seconds.
   */
  async refresh(dto: RefreshTokenDto) {
    const record = await this.prisma.authToken.findUnique({
      where: { tokenHash: this.hashRefreshToken(dto.refreshToken) },
      include: { user: true },
    });

    const outsideGrace =
      !!record?.usedAt &&
      Date.now() - record.usedAt.getTime() > REFRESH_REUSE_GRACE_MS;

    if (
      !record ||
      record.type !== 'REFRESH' ||
      outsideGrace ||
      record.expiresAt < new Date()
    ) {
      throw new UnauthorizedException({
        code: 'SESSION_EXPIRED',
        message: 'Your session has expired. Please sign in again.',
      });
    }

    // A ban applied mid-session must end it: without this the account keeps
    // renewing forever off a token issued before it was blocked.
    this.assertNotBlocked(record.user);

    // Keep the first burn time — refreshing it would let the grace window slide
    // forward indefinitely and the token would never actually die.
    if (!record.usedAt) {
      await this.prisma.authToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      });
    }

    return {
      ...(await this.issueSession(record.user)),
      user: this.sanitize(record.user),
    };
  }

  /**
   * Signing out drops the refresh token outright so it can't outlive the
   * session — deleted, not burned, for the same reason as `revokeAllRefreshTokens`.
   */
  async logout(dto: RefreshTokenDto) {
    await this.prisma.authToken.deleteMany({
      where: { tokenHash: this.hashRefreshToken(dto.refreshToken), type: 'REFRESH' },
    });

    return { message: 'Signed out.' };
  }

  // Reused by AdminService to send a fresh invited-admin a "set your password" code
  // via the same PASSWORD_RESET token mechanism, just with invite-flavored email copy.
  async issuePasswordResetOtp(user: User, mailPurpose: 'reset' | 'invite' = 'reset') {
    return this.issueOtp(user, 'PASSWORD_RESET', mailPurpose);
  }

  private async issueOtp(
    user: User,
    type: AuthTokenType,
    mailPurpose?: 'verify' | 'reset' | 'invite',
  ) {
    await this.prisma.authToken.deleteMany({
      where: { userId: user.id, type, usedAt: null },
    });

    const otp = randomInt(100_000, 1_000_000).toString();
    const ttlMinutes = type === 'EMAIL_VERIFY' ? EMAIL_OTP_TTL_MINUTES : PASSWORD_RESET_OTP_TTL_MINUTES;

    await this.prisma.authToken.create({
      data: {
        userId: user.id,
        type,
        tokenHash: this.hashOtp(user.id, otp),
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      },
    });

    await this.mail.sendOtpEmail(user.email, otp, mailPurpose ?? (type === 'EMAIL_VERIFY' ? 'verify' : 'reset'));
  }

  private async consumeOtp(user: User, type: AuthTokenType, otp: string, consume = true) {
    const token = await this.prisma.authToken.findFirst({
      where: { userId: user.id, type, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!token || token.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired code');
    }

    if (token.attempts >= OTP_MAX_ATTEMPTS) {
      throw new BadRequestException('Too many attempts. Please request a new code.');
    }

    if (token.tokenHash !== this.hashOtp(user.id, otp)) {
      await this.prisma.authToken.update({
        where: { id: token.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Invalid or expired code');
    }

    if (consume) {
      await this.prisma.authToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      });
    }
  }

  private hashOtp(userId: string, otp: string) {
    return createHash('sha256').update(`${userId}:${otp}`).digest('hex');
  }

  /**
   * A blocked account is banned outright, so it must not be able to obtain a
   * session — checked on sign-in and again on refresh, or a session created
   * before the ban would simply keep renewing itself.
   */
  private assertNotBlocked(user: Pick<User, 'accountStatus' | 'statusReason'>) {
    if (user.accountStatus !== 'BLOCKED') return;

    throw new ForbiddenException({
      code: 'ACCOUNT_BLOCKED',
      message: user.statusReason
        ? `This account has been blocked: ${user.statusReason}`
        : 'This account has been blocked.',
    });
  }

  // Refresh tokens are looked up before we know who is asking, so the hash is
  // keyed on the token alone — safe because it's 32 bytes of CSPRNG, not a
  // guessable 6-digit OTP.
  private hashRefreshToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  /** A short-lived access token plus the long-lived token that renews it. */
  private async issueSession(user: Pick<User, 'id' | 'email' | 'role'>) {
    return {
      accessToken: this.signToken(user),
      refreshToken: await this.issueRefreshToken(user.id),
    };
  }

  private async issueRefreshToken(userId: string) {
    const token = randomBytes(32).toString('hex');

    // Rotation writes a row per renewal — hourly, per device, for as long as the
    // account lives. Sweep this user's dead rows here so the table stays bounded
    // without needing a scheduled job.
    await this.prisma.authToken.deleteMany({
      where: {
        userId,
        type: 'REFRESH',
        OR: [
          { expiresAt: { lt: new Date() } },
          { usedAt: { lt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS) } },
        ],
      },
    });

    await this.prisma.authToken.create({
      data: {
        userId,
        type: 'REFRESH',
        tokenHash: this.hashRefreshToken(token),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      },
    });

    return token;
  }

  // Deleted rather than burned: a burned token stays usable for the rotation
  // grace window, and revocation has to be immediate and absolute. A missing
  // row can't be graced.
  private async revokeAllRefreshTokens(userId: string) {
    await this.prisma.authToken.deleteMany({ where: { userId, type: 'REFRESH' } });
  }

  private signToken(user: Pick<User, 'id' | 'email' | 'role'>) {
    return this.jwt.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
  }

  private sanitize(user: User) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      creatorStatus: user.creatorStatus,
      pointsBalance: user.pointsBalance.toString(),
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    };
  }
}
