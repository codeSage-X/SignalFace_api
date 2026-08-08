import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { FollowQueryDto } from './dto/follow-query.dto';
import type { User, Signal } from '@signal-face/db';

type UserWithRelations = User & {
  signal: Signal | null;
  _count: { follows: number; followers: number };
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async getFullProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        signal: true,
        _count: { select: { follows: true, followers: true } },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const likesCount = await this.prisma.like.count({ where: { post: { authorId: userId } } });

    return this.toProfileDto(user, likesCount);
  }

  /**
   * Someone else's profile, by username. Excludes account-private fields
   * (email, points balance) and reports whether the viewer follows them.
   */
  async getPublicProfile(username: string, viewerId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      include: {
        signal: true,
        _count: { select: { follows: true, followers: true, posts: true } },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const [likesCount, followRow] = await Promise.all([
      this.prisma.like.count({ where: { post: { authorId: user.id } } }),
      viewerId && viewerId !== user.id
        ? this.prisma.follow.findUnique({
            where: { followerId_followingId: { followerId: viewerId, followingId: user.id } },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      websiteUrl: user.websiteUrl,
      role: user.role,
      creatorStatus: user.creatorStatus,
      createdAt: user.createdAt,
      followingCount: user._count.follows,
      followersCount: user._count.followers,
      postsCount: user._count.posts,
      likesCount,
      isMe: viewerId === user.id,
      isFollowedByMe: Boolean(followRow),
      signal: user.signal
        ? {
            id: user.signal.id,
            score: user.signal.score.toString(),
            price: user.signal.price.toString(),
            prevScore: user.signal.prevScore.toString(),
            growthPct: user.signal.growthPct.toString(),
            lastScoredAt: user.signal.lastScoredAt,
          }
        : null,
    };
  }

  async toggleFollow(username: string, viewerId: string) {
    const target = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true },
    });
    if (!target) {
      throw new NotFoundException('User not found');
    }
    if (target.id === viewerId) {
      throw new BadRequestException('You cannot follow yourself');
    }

    const existing = await this.prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerId, followingId: target.id } },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.follow.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.follow.create({
        data: { followerId: viewerId, followingId: target.id },
      });
    }

    const followersCount = await this.prisma.follow.count({
      where: { followingId: target.id },
    });

    return { username: username.toLowerCase(), following: !existing, followersCount };
  }

  /**
   * Accounts the viewer follows. Paginated on the `Follow` row id rather than the
   * user id, because the cursor has to walk the join table the ordering comes from.
   */
  async listFollowing(viewerId: string, query: FollowQueryDto) {
    return this.listFollowEdges(viewerId, 'following', query);
  }

  /** Accounts following the viewer. */
  async listFollowers(viewerId: string, query: FollowQueryDto) {
    return this.listFollowEdges(viewerId, 'followers', query);
  }

  private async listFollowEdges(
    viewerId: string,
    direction: 'following' | 'followers',
    query: FollowQueryDto,
  ) {
    const take = query.limit ?? 20;

    const rows = await this.prisma.follow.findMany({
      where:
        direction === 'following' ? { followerId: viewerId } : { followingId: viewerId },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        [direction === 'following' ? 'following' : 'follower']: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            creatorStatus: true,
            _count: { select: { followers: true } },
          },
        },
      },
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const people = page.map((row: any) =>
      direction === 'following' ? row.following : row.follower,
    );

    // Whether the viewer follows each of these accounts back. Always true in the
    // `following` direction; for followers it takes one extra lookup rather than
    // a query per row.
    let followedBack: Set<string>;
    if (direction === 'following') {
      followedBack = new Set(people.map((p) => p.id));
    } else {
      const edges = await this.prisma.follow.findMany({
        where: { followerId: viewerId, followingId: { in: people.map((p) => p.id) } },
        select: { followingId: true },
      });
      followedBack = new Set(edges.map((e) => e.followingId));
    }

    return {
      items: people.map((person) => ({
        id: person.id,
        username: person.username,
        displayName: person.displayName,
        avatarUrl: person.avatarUrl,
        creatorStatus: person.creatorStatus,
        followersCount: person._count.followers,
        isFollowedByMe: followedBack.has(person.id),
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.bio !== undefined && { bio: dto.bio }),
        ...(dto.websiteUrl !== undefined && { websiteUrl: dto.websiteUrl }),
      },
    });
    return this.getFullProfile(userId);
  }

  async updateAccount(userId: string, dto: UpdateAccountDto) {
    const current = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!current) {
      throw new NotFoundException('User not found');
    }

    const emailChanged = dto.email !== undefined && dto.email !== current.email;
    const nextUsername = dto.username?.toLowerCase();
    const usernameChanged = nextUsername !== undefined && nextUsername !== current.username;

    if (emailChanged) {
      const taken = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (taken) {
        throw new ConflictException('An account with this email already exists');
      }
    }
    if (usernameChanged) {
      const taken = await this.prisma.user.findUnique({ where: { username: nextUsername } });
      if (taken) {
        throw new ConflictException('That username is already taken');
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(emailChanged && { email: dto.email, emailVerified: false }),
        ...(usernameChanged && { username: nextUsername }),
        ...(dto.displayName !== undefined && { displayName: dto.displayName }),
      },
    });

    return this.getFullProfile(userId);
  }

  async uploadAvatar(userId: string, file: Express.Multer.File) {
    const url = await this.cloudinary.uploadImage(file.buffer, {
      folder: 'signalface/avatars',
      publicId: userId,
    });
    await this.prisma.user.update({ where: { id: userId }, data: { avatarUrl: url } });
    return this.getFullProfile(userId);
  }

  private toProfileDto(user: UserWithRelations, likesCount: number) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      websiteUrl: user.websiteUrl,
      role: user.role,
      creatorStatus: user.creatorStatus,
      pointsBalance: user.pointsBalance.toString(),
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      followingCount: user._count.follows,
      followersCount: user._count.followers,
      likesCount,
      signal: user.signal
        ? {
            id: user.signal.id,
            score: user.signal.score.toString(),
            price: user.signal.price.toString(),
            prevScore: user.signal.prevScore.toString(),
            growthPct: user.signal.growthPct.toString(),
            lastScoredAt: user.signal.lastScoredAt,
          }
        : null,
    };
  }
}
