import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { randomInt, createHash } from 'crypto';
import { EMAIL_OTP_TTL_MINUTES, PASSWORD_RESET_OTP_TTL_MINUTES, OTP_MAX_ATTEMPTS } from '@signal-face/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { FirebaseService } from '../firebase/firebase.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyResetOtpDto } from './dto/verify-reset-otp.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import type { User, AuthTokenType } from '@signal-face/db';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly firebase: FirebaseService,
  ) {}

  async register(dto: RegisterDto) {
    const [emailTaken, usernameTaken] = await Promise.all([
      this.prisma.user.findUnique({ where: { email: dto.email } }),
      this.prisma.user.findUnique({ where: { username: dto.username } }),
    ]);

    if (emailTaken) {
      throw new ConflictException('An account with this email already exists');
    }
    if (usernameTaken) {
      throw new ConflictException('That username is already taken');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        username: dto.username.toLowerCase(),
        displayName: `${dto.firstName} ${dto.lastName}`,
        dateOfBirth: new Date(dto.dateOfBirth),
        gender: dto.gender,
      },
    });

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

    const accessToken = this.signToken(user);
    return { accessToken, user: this.sanitize(user) };
  }

  async googleAuth(dto: GoogleAuthDto) {
    const identity = await this.firebase.verifyIdToken(dto.idToken);

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ firebaseUid: identity.uid }, { email: identity.email }] },
    });

    if (existing) {
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

      const accessToken = this.signToken(user);
      return { accessToken, user: this.sanitize(user), isNewUser: false };
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

    const accessToken = this.signToken(user);
    return { accessToken, user: this.sanitize(user), isNewUser: true };
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

    const accessToken = this.signToken(verifiedUser);
    return { accessToken, user: this.sanitize(verifiedUser) };
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

    const accessToken = this.signToken(updated);
    return { accessToken, user: this.sanitize(updated) };
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
