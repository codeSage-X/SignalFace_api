import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { CreatePostDto } from './dto/create-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { FeedQueryDto } from './dto/feed-query.dto';

export const MAX_PINNED_POSTS = 3;
const DEFAULT_PAGE_SIZE = 12;

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv'];

const AUTHOR_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  role: true,
  creatorStatus: true,
} as const;

/**
 * A realm post is displayed as the page, not the person — everywhere it
 * appears it needs the page's name and avatar, so they travel with the post.
 */
const REALM_SELECT = {
  id: true,
  name: true,
  slug: true,
  iconUrl: true,
  category: true,
} as const;

type PostWithAuthor = {
  id: string;
  body: string | null;
  mediaUrls: string[];
  likeCount: number;
  commentCount: number;
  viewCount: number;
  bookmarkCount: number;
  pinned: boolean;
  createdAt: Date;
  realmId: string | null;
  realm?: {
    id: string;
    name: string;
    slug: string;
    iconUrl: string | null;
    category: string;
    /** Present only when there is a viewer; a row means they follow the realm. */
    members?: { id: string }[];
  } | null;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    role: string;
    creatorStatus: string;
    followers?: { id: string }[];
  };
  likes?: { userId: string }[];
  bookmarks?: { userId: string }[];
};

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /**
   * What to include on a post read. The viewer's own like/bookmark rows are
   * pulled in only when there is a viewer, so `likedByMe`/`bookmarkedByMe`
   * can be resolved without a second round trip.
   */
  /** Realm fields plus, when there is a viewer, whether they follow the page. */
  private realmSelect(viewerId?: string) {
    return {
      ...REALM_SELECT,
      ...(viewerId
        ? { members: { where: { userId: viewerId }, select: { id: true } } }
        : {}),
    };
  }

  private include(viewerId?: string) {
    return {
      realm: { select: this.realmSelect(viewerId) },
      author: {
        select: {
          ...AUTHOR_SELECT,
          // Rows here mean "viewer follows this author" — Follow.followingId is
          // the author and followerId is the viewer.
          ...(viewerId
            ? { followers: { where: { followerId: viewerId }, select: { id: true } } }
            : {}),
        },
      },
      ...(viewerId
        ? {
            likes: { where: { userId: viewerId }, select: { userId: true } },
            bookmarks: { where: { userId: viewerId }, select: { userId: true } },
          }
        : {}),
    };
  }

  async create(userId: string, dto: CreatePostDto, files: Express.Multer.File[]) {
    const body = dto.body?.trim();

    if (!body && (!files || files.length === 0)) {
      throw new BadRequestException('A post needs text or media');
    }

    // Posting as a realm is only possible on your own page — otherwise anyone
    // could publish under someone else's brand.
    if (dto.realmId) {
      const realm = await this.prisma.realm.findUnique({
        where: { id: dto.realmId },
        select: { ownerId: true, status: true },
      });

      if (!realm || realm.ownerId !== userId) {
        throw new ForbiddenException('You can only post as a realm you own');
      }
      if (realm.status !== 'APPROVED') {
        throw new ForbiddenException('This realm is not active');
      }
    }

    const mediaUrls: string[] = [];
    for (const file of files ?? []) {
      const { url } = await this.cloudinary.uploadMedia(file.buffer, {
        folder: `signal-face/posts/${userId}`,
        publicId: randomUUID(),
      });
      mediaUrls.push(url);
    }

    const post = await this.prisma.post.create({
      data: {
        authorId: userId,
        body: body || null,
        mediaUrls,
        realmId: dto.realmId || null,
      },
      include: {
        author: { select: AUTHOR_SELECT },
        realm: { select: this.realmSelect(userId) },
      },
    });

    return this.serialize(post as PostWithAuthor, userId);
  }

  /** Reverse-chronological feed of everyone's posts, cursor paginated. */
  async feed(query: FeedQueryDto, viewerId?: string) {
    const take = query.limit ?? DEFAULT_PAGE_SIZE;

    const posts = await this.prisma.post.findMany({
      take: take + 1, // one extra row tells us whether another page exists
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: this.include(viewerId),
    });

    return this.paginate(posts as PostWithAuthor[], take, viewerId);
  }

  /**
   * An author's posts. Pinned ones lead the list — `pinned: 'desc'` puts true
   * first, and the max-3 cap keeps that prefix small.
   */
  async byUsername(username: string, query: FeedQueryDto, viewerId?: string) {
    const author = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true },
    });

    if (!author) {
      throw new NotFoundException('No such user');
    }

    const take = query.limit ?? DEFAULT_PAGE_SIZE;

    const posts = await this.prisma.post.findMany({
      where: { authorId: author.id },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      include: this.include(viewerId),
    });

    return this.paginate(posts as PostWithAuthor[], take, viewerId);
  }

  /**
   * A realm's own feed — the posts published under that page. Distinct from
   * `byUsername`, which returns everything the owner posted, personal included.
   */
  async byRealmSlug(slug: string, query: FeedQueryDto, viewerId?: string) {
    const realm = await this.prisma.realm.findUnique({
      where: { slug: slug.toLowerCase() },
      select: { id: true },
    });

    if (!realm) {
      throw new NotFoundException('No such realm');
    }

    const take = query.limit ?? DEFAULT_PAGE_SIZE;

    const posts = await this.prisma.post.findMany({
      where: { realmId: realm.id },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      include: this.include(viewerId),
    });

    return this.paginate(posts as PostWithAuthor[], take, viewerId);
  }

  async findOne(postId: string, viewerId?: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: this.include(viewerId),
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    return this.serialize(post as PostWithAuthor, viewerId);
  }

  async remove(postId: string, userId: string, role: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true },
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (post.authorId !== userId && role !== 'ADMIN') {
      throw new ForbiddenException('You can only delete your own posts');
    }

    await this.prisma.post.delete({ where: { id: postId } });
    return { id: postId, deleted: true };
  }

  async toggleLike(postId: string, userId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const existing = await this.prisma.like.findUnique({
      where: { postId_userId: { postId, userId } },
    });

    // The counter and the Like row must move together, or the UI drifts.
    const [, updated] = await this.prisma.$transaction([
      existing
        ? this.prisma.like.delete({ where: { id: existing.id } })
        : this.prisma.like.create({ data: { postId, userId } }),
      this.prisma.post.update({
        where: { id: postId },
        data: { likeCount: { increment: existing ? -1 : 1 } },
        select: { likeCount: true },
      }),
    ]);

    return { postId, liked: !existing, likeCount: updated.likeCount };
  }

  async toggleBookmark(postId: string, userId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const existing = await this.prisma.bookmark.findUnique({
      where: { postId_userId: { postId, userId } },
    });

    const [, updated] = await this.prisma.$transaction([
      existing
        ? this.prisma.bookmark.delete({ where: { id: existing.id } })
        : this.prisma.bookmark.create({ data: { postId, userId } }),
      this.prisma.post.update({
        where: { id: postId },
        data: { bookmarkCount: { increment: existing ? -1 : 1 } },
        select: { bookmarkCount: true },
      }),
    ]);

    return { postId, bookmarked: !existing, bookmarkCount: updated.bookmarkCount };
  }

  /**
   * The viewer's saved posts, newest save first. Paginated on the Bookmark id
   * rather than the post id, since the ordering is by when it was saved.
   */
  async bookmarks(userId: string, query: FeedQueryDto) {
    const take = query.limit ?? DEFAULT_PAGE_SIZE;

    const rows = await this.prisma.bookmark.findMany({
      where: { userId },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { post: { include: this.include(userId) } },
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    return {
      items: page.map((row) => this.serialize(row.post as PostWithAuthor, userId)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /** Top-level comments only. Replies are fetched per comment, on demand. */
  async comments(postId: string, query: FeedQueryDto) {
    const take = query.limit ?? 20;

    const rows = await this.prisma.comment.findMany({
      where: { postId, parentId: null },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { author: { select: AUTHOR_SELECT } },
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    return {
      items: page.map((c) => this.serializeComment(c)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /** Replies to one comment, oldest first so a thread reads top to bottom. */
  async replies(commentId: string, query: FeedQueryDto) {
    const parent = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true },
    });
    if (!parent) {
      throw new NotFoundException('Comment not found');
    }

    const take = query.limit ?? 20;

    const rows = await this.prisma.comment.findMany({
      where: { parentId: commentId },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { author: { select: AUTHOR_SELECT } },
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    return {
      items: page.map((c) => this.serializeComment(c)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async addComment(postId: string, userId: string, dto: CreateCommentDto) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }

    // Resolve the thread root. Replying to a reply attaches to its parent
    // instead of nesting deeper, so threads stay one level like TikTok's.
    let parentId: string | null = null;
    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: dto.parentId },
        select: { id: true, postId: true, parentId: true },
      });

      if (!parent || parent.postId !== postId) {
        throw new BadRequestException('That comment does not belong to this post');
      }

      parentId = parent.parentId ?? parent.id;
    }

    const comment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.comment.create({
        data: { postId, authorId: userId, body: dto.body.trim(), parentId },
        include: { author: { select: AUTHOR_SELECT } },
      });

      // Replies count toward the post total as well, so the feed badge
      // reflects total conversation rather than only top-level comments.
      await tx.post.update({
        where: { id: postId },
        data: { commentCount: { increment: 1 } },
      });

      if (parentId) {
        await tx.comment.update({
          where: { id: parentId },
          data: { replyCount: { increment: 1 } },
        });
      }

      return created;
    });

    return this.serializeComment(comment);
  }

  private serializeComment(comment: {
    id: string;
    body: string;
    createdAt: Date;
    parentId: string | null;
    replyCount: number;
    author: unknown;
  }) {
    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      parentId: comment.parentId,
      replyCount: comment.replyCount,
      author: comment.author,
    };
  }

  /** Fire-and-forget from the client when a post scrolls into view. */
  async registerView(postId: string) {
    try {
      const post = await this.prisma.post.update({
        where: { id: postId },
        data: { viewCount: { increment: 1 } },
        select: { viewCount: true },
      });
      return { postId, viewCount: post.viewCount };
    } catch {
      throw new NotFoundException('Post not found');
    }
  }

  async setPinned(postId: string, userId: string, pinned: boolean) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true, pinned: true },
    });

    if (!post) {
      throw new NotFoundException('Post not found');
    }
    if (post.authorId !== userId) {
      throw new ForbiddenException('You can only pin your own posts');
    }

    if (pinned && !post.pinned) {
      const alreadyPinned = await this.prisma.post.count({
        where: { authorId: userId, pinned: true },
      });
      if (alreadyPinned >= MAX_PINNED_POSTS) {
        throw new BadRequestException(
          `You can pin at most ${MAX_PINNED_POSTS} posts. Unpin one first.`,
        );
      }
    }

    const updated = await this.prisma.post.update({
      where: { id: postId },
      data: { pinned },
      select: { id: true, pinned: true },
    });

    return updated;
  }

  private paginate(rows: PostWithAuthor[], take: number, viewerId?: string) {
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;

    return {
      items: page.map((p) => this.serialize(p, viewerId)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * The schema stores media as bare URLs, so the post's kind is inferred:
   * no media is text, a video extension (or Cloudinary's /video/ path) is
   * video, anything else is treated as an image.
   */
  private serialize(post: PostWithAuthor, viewerId?: string) {
    const [firstMedia] = post.mediaUrls;
    let kind: 'text' | 'image' | 'video' = 'text';

    if (firstMedia) {
      const lower = firstMedia.toLowerCase();
      const isVideo =
        lower.includes('/video/upload/') || VIDEO_EXTENSIONS.some((ext) => lower.includes(ext));
      kind = isVideo ? 'video' : 'image';
    }

    return {
      id: post.id,
      kind,
      body: post.body,
      mediaUrls: post.mediaUrls,
      likeCount: post.likeCount,
      commentCount: post.commentCount,
      viewCount: post.viewCount,
      bookmarkCount: post.bookmarkCount,
      pinned: post.pinned,
      realmId: post.realmId,
      // Present only on realm posts. When set, clients credit the page instead
      // of the author — the author is still carried for ownership checks.
      realm: post.realm
        ? {
            id: post.realm.id,
            name: post.realm.name,
            slug: post.realm.slug,
            iconUrl: post.realm.iconUrl,
            category: post.realm.category,
            followedByMe: Boolean(
              viewerId && post.realm.members && post.realm.members.length > 0,
            ),
          }
        : null,
      createdAt: post.createdAt,
      author: {
        id: post.author.id,
        username: post.author.username,
        displayName: post.author.displayName,
        avatarUrl: post.author.avatarUrl,
        role: post.author.role,
        creatorStatus: post.author.creatorStatus,
        followedByMe: Boolean(
          viewerId && post.author.followers && post.author.followers.length > 0,
        ),
      },
      likedByMe: Boolean(viewerId && post.likes && post.likes.length > 0),
      bookmarkedByMe: Boolean(viewerId && post.bookmarks && post.bookmarks.length > 0),
      isMine: Boolean(viewerId && post.author.id === viewerId),
    };
  }
}
