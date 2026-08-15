import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { RealmCategory } from '@signal-face/db';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { CreatePostDto } from './dto/create-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { FeedQueryDto } from './dto/feed-query.dto';

export const MAX_PINNED_POSTS = 3;
const DEFAULT_PAGE_SIZE = 12;

/**
 * How the feed is mixed: this many posts from the viewer's interests for every
 * one from everywhere else, so roughly two thirds is on-topic.
 *
 * A quota rather than a scoring bonus. The first attempt scored a matching post
 * as if it were N hours newer, which sounds equivalent but isn't: whether the
 * boost wins depends entirely on how far apart the two streams happen to be in
 * time. On real data the newest post of one category was 26 hours older than
 * another's, so an 18-hour bonus changed nothing at all — a niche interest would
 * simply never appear, while a busy one would crowd out everything else. A ratio
 * holds regardless of how active any topic is.
 */
const INTEREST_RATIO = 2;

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
  category: RealmCategory | null;
  aspectRatio: string | null;
  coverUrl: string | null;
  likeCount: number;
  commentCount: number;
  viewCount: number;
  bookmarkCount: number;
  repostCount: number;
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
  reposts?: { userId: string }[];
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
            reposts: { where: { userId: viewerId }, select: { userId: true } },
          }
        : {}),
    };
  }

  async create(
    userId: string,
    dto: CreatePostDto,
    files: Express.Multer.File[],
    cover?: Express.Multer.File,
  ) {
    const body = dto.body?.trim();

    if (!body && (!files || files.length === 0)) {
      throw new BadRequestException('A post needs text or media');
    }

    // What the post is about, for feed ranking and topic browsing. Resolved once
    // here rather than joined on every read. An explicit choice always wins —
    // a tech creator posting about food should land under food.
    let category: RealmCategory | null = dto.category ?? null;

    // Posting as a realm is only possible on your own page — otherwise anyone
    // could publish under someone else's brand.
    if (dto.realmId) {
      const realm = await this.prisma.realm.findUnique({
        where: { id: dto.realmId },
        select: { ownerId: true, status: true, category: true },
      });

      if (!realm || realm.ownerId !== userId) {
        throw new ForbiddenException('You can only post as a realm you own');
      }
      if (realm.status !== 'APPROVED') {
        throw new ForbiddenException('This realm is not active');
      }

      category = category ?? realm.category;
    } else if (!category) {
      // A personal post still has a topic if its author runs a realm — a tech
      // creator posting from their own account is still posting about tech.
      const ownRealm = await this.prisma.realm.findUnique({
        where: { ownerId: userId },
        select: { category: true },
      });
      category = ownRealm?.category ?? null;
    }

    const mediaUrls: string[] = [];
    for (const file of files ?? []) {
      const { url } = await this.cloudinary.uploadMedia(file.buffer, {
        folder: `signal-face/posts/${userId}`,
        publicId: randomUUID(),
      });
      mediaUrls.push(url);
    }

    // The cover is a still the client extracted from the video, so it goes up as
    // an image rather than through the auto-detecting media path.
    let coverUrl: string | null = null;
    if (cover) {
      coverUrl = await this.cloudinary.uploadImage(cover.buffer, {
        folder: `signal-face/covers/${userId}`,
        publicId: randomUUID(),
      });
    }

    const post = await this.prisma.post.create({
      data: {
        authorId: userId,
        body: body || null,
        mediaUrls,
        realmId: dto.realmId || null,
        category,
        aspectRatio: dto.aspectRatio ?? null,
        coverUrl,
      },
      include: {
        author: { select: AUTHOR_SELECT },
        realm: { select: this.realmSelect(userId) },
      },
    });

    return this.serialize(post as PostWithAuthor, userId);
  }

  /**
   * The topics that should be favoured for this viewer: what they chose at
   * sign-up, plus the category of their own realm — a comedy creator is
   * interested in comedy whether or not they ticked the box.
   */
  private async viewerInterests(viewerId: string): Promise<RealmCategory[]> {
    const [user, ownRealm] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: viewerId },
        select: { interests: true },
      }),
      this.prisma.realm.findUnique({
        where: { ownerId: viewerId },
        select: { category: true },
      }),
    ]);

    const merged = new Set<RealmCategory>(user?.interests ?? []);
    if (ownRealm?.category) merged.add(ownRealm.category);
    return [...merged];
  }

  /**
   * The feed, personalised.
   *
   * Ranking is recency with a boost: a post whose topic the viewer cares about
   * is scored as if it were `INTEREST_BOOST_HOURS` newer than it is. That
   * interleaves rather than segregates — sorting matched posts strictly first
   * would bury every general post behind an inexhaustible stream of matches, so
   * a viewer would never see anything outside their own bubble, and a quiet
   * interest would leave them with a stale feed.
   *
   * Done in SQL because the score is computed per row and has to drive both the
   * ordering and the cursor. Only ids are selected here; the rows are then
   * hydrated through the usual `include` so every caller gets the same shape.
   */
  async feed(query: FeedQueryDto, viewerId?: string) {
    const take = query.limit ?? DEFAULT_PAGE_SIZE;
    const interests = viewerId ? await this.viewerInterests(viewerId) : [];

    // Signed out, or no stated interests: nothing to rank on, so the plain
    // reverse-chronological path is both correct and cheaper.
    if (interests.length === 0) {
      const posts = await this.prisma.post.findMany({
        take: take + 1, // one extra row tells us whether another page exists
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: this.include(viewerId),
      });

      return this.paginate(posts as PostWithAuthor[], take, viewerId);
    }

    // Two independent streams, each newest-first, merged to the quota below.
    // The cursor tracks a position in each, since they advance at different
    // rates and neither alone describes where the viewer is.
    const cursor = this.decodeFeedCursor(query.cursor);

    // Enough of each to fill the page in the intended proportion, plus one
    // spare per stream so "is there more?" can be answered without a count.
    const wantMatched = Math.ceil(((take + 1) * INTEREST_RATIO) / (INTEREST_RATIO + 1));
    const wantGeneral = take + 1 - wantMatched;

    const [matched, general] = await Promise.all([
      this.prisma.post.findMany({
        where: { category: { in: interests } },
        take: wantMatched + 1,
        ...(cursor?.matched ? { cursor: { id: cursor.matched }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: this.include(viewerId),
      }),
      this.prisma.post.findMany({
        // Uncategorised posts count as general — most personal posts have no
        // topic, and excluding them would hide most of the platform.
        where: { OR: [{ category: null }, { category: { notIn: interests } }] },
        take: wantGeneral + 1,
        ...(cursor?.general ? { cursor: { id: cursor.general }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: this.include(viewerId),
      }),
    ]);

    const items: PostWithAuthor[] = [];
    let m = 0;
    let g = 0;

    // Walk the two streams in an N:1 pattern, and when one runs out let the
    // other fill the rest — a viewer whose interest is quiet still gets a full
    // page, and so does one who follows nothing but their own topic.
    while (items.length < take && (m < matched.length || g < general.length)) {
      for (let i = 0; i < INTEREST_RATIO && items.length < take; i++) {
        if (m < matched.length) items.push(matched[m++] as PostWithAuthor);
        else if (g < general.length) items.push(general[g++] as PostWithAuthor);
      }

      if (items.length < take) {
        if (g < general.length) items.push(general[g++] as PostWithAuthor);
        else if (m < matched.length) items.push(matched[m++] as PostWithAuthor);
      }
    }

    const hasMore = m < matched.length || g < general.length;

    // Carry forward the previous position for a stream this page didn't touch,
    // or paging would silently restart it.
    const nextMatched = m > 0 ? matched[m - 1].id : (cursor?.matched ?? null);
    const nextGeneral = g > 0 ? general[g - 1].id : (cursor?.general ?? null);

    return {
      items: items.map((post) => this.serialize(post, viewerId)),
      nextCursor: hasMore ? this.encodeFeedCursor(nextMatched, nextGeneral) : null,
    };
  }

  /** Opaque to clients: one position per stream. */
  private encodeFeedCursor(matched: string | null, general: string | null) {
    return Buffer.from(`${matched ?? ''}|${general ?? ''}`).toString('base64url');
  }

  private decodeFeedCursor(
    cursor?: string,
  ): { matched: string | null; general: string | null } | null {
    if (!cursor) return null;

    try {
      const decoded = Buffer.from(cursor, 'base64url').toString();
      // A cursor from the unranked path is a bare post id with no separator —
      // start over rather than erroring at the viewer.
      if (!decoded.includes('|')) return null;

      const [matched, general] = decoded.split('|');
      return { matched: matched || null, general: general || null };
    } catch {
      return null;
    }
  }

  /**
   * Posts matching a free-text query, over the caption and the author's handle,
   * so searching a creator's name surfaces their posts as well as their account.
   *
   * `videosOnly` backs the Videos tab; without it the tab would show text posts.
   */
  async search(
    term: string,
    query: FeedQueryDto,
    viewerId?: string,
    videosOnly = false,
  ) {
    const q = term.trim();
    const category = query.category;

    // A category on its own is a valid browse — that is how Explore narrows its
    // posts to a topic. Only a request with neither is meaningless.
    if (!q && !category) return { items: [], nextCursor: null };

    const take = query.limit ?? DEFAULT_PAGE_SIZE;
    const contains = { contains: q, mode: 'insensitive' as const };

    const posts = await this.prisma.post.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(q
          ? {
              OR: [
                { body: contains },
                { author: { username: contains } },
                { author: { displayName: contains } },
                { realm: { name: contains } },
              ],
            }
          : {}),
        // Postgres arrays can't be filtered by element pattern here, so videos
        // are narrowed by "has media" and the exact kind is settled below.
        ...(videosOnly ? { NOT: { mediaUrls: { isEmpty: true } } } : {}),
      },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: this.include(viewerId),
    });

    const result = this.paginate(posts as PostWithAuthor[], take, viewerId);

    // Kind lives in the URL rather than a column, so the video filter finishes
    // here. It can thin a page, which is why nextCursor is left untouched —
    // dropping it would end pagination early and hide later matches.
    return videosOnly
      ? { ...result, items: result.items.filter((p) => p.kind === 'video') }
      : result;
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

  async toggleRepost(postId: string, userId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const existing = await this.prisma.repost.findUnique({
      where: { postId_userId: { postId, userId } },
    });

    const [, updated] = await this.prisma.$transaction([
      existing
        ? this.prisma.repost.delete({ where: { id: existing.id } })
        : this.prisma.repost.create({ data: { postId, userId } }),
      this.prisma.post.update({
        where: { id: postId },
        data: { repostCount: { increment: existing ? -1 : 1 } },
        select: { repostCount: true },
      }),
    ]);

    return { postId, reposted: !existing, repostCount: updated.repostCount };
  }

  /**
   * The viewer's saved posts, newest save first. Paginated on the Bookmark id
   * rather than the post id, since the ordering is by when it was saved.
   */
  async bookmarks(userId: string, query: FeedQueryDto) {
    return this.collection('bookmark', userId, query);
  }

  /** The viewer's reposts, newest first. */
  async reposts(userId: string, query: FeedQueryDto) {
    return this.collection('repost', userId, query);
  }

  /** The viewer's liked posts, newest like first. */
  async liked(userId: string, query: FeedQueryDto) {
    return this.collection('like', userId, query);
  }

  /**
   * Bookmarks, reposts and likes are the same query over three join tables:
   * this user's rows, newest first, with the post hydrated. The cursor is the
   * join row's id, not the post's, because the ordering is by when the user
   * acted rather than when the post was made.
   */
  private async collection(
    table: 'bookmark' | 'repost' | 'like',
    userId: string,
    query: FeedQueryDto,
  ) {
    const take = query.limit ?? DEFAULT_PAGE_SIZE;

    // One query definition, but dispatched against a concrete delegate: the three
    // findMany signatures aren't mutually assignable, so `prisma[table]` can't be
    // called directly without discarding the types.
    const args = {
      where: { userId },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
      include: { post: { include: this.include(userId) } },
    };

    const rows =
      table === 'bookmark'
        ? await this.prisma.bookmark.findMany(args)
        : table === 'repost'
          ? await this.prisma.repost.findMany(args)
          : await this.prisma.like.findMany(args);

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

  /** A bare URL is all the schema stores, so each item's type is inferred. */
  private isVideoUrl(url: string) {
    const lower = url.toLowerCase();
    return (
      lower.includes('/video/upload/') || VIDEO_EXTENSIONS.some((ext) => lower.includes(ext))
    );
  }

  /**
   * The schema stores media as bare URLs, so the post's kind is inferred:
   * no media is text, a video first is video, anything else is image.
   *
   * `kind` describes the *lead* item only, which is all a thumbnail needs. A post
   * can legitimately mix a video and images, so `media` carries each item with
   * its own type — clients that render the whole post must use that, or a mixed
   * post loses everything after the first item.
   */
  private serialize(post: PostWithAuthor, viewerId?: string) {
    const media = post.mediaUrls.map((url) => ({
      url,
      kind: this.isVideoUrl(url) ? ('video' as const) : ('image' as const),
    }));

    const kind: 'text' | 'image' | 'video' = media.length === 0 ? 'text' : media[0].kind;

    return {
      media,
      id: post.id,
      kind,
      body: post.body,
      mediaUrls: post.mediaUrls,
      // What the post is about. Clients surface it, and it is what the feed
      // ranks on, so it has to be visible to check the ranking is working.
      category: post.category,
      aspectRatio: post.aspectRatio,
      coverUrl: post.coverUrl,
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
      repostCount: post.repostCount,
      likedByMe: Boolean(viewerId && post.likes && post.likes.length > 0),
      bookmarkedByMe: Boolean(viewerId && post.bookmarks && post.bookmarks.length > 0),
      repostedByMe: Boolean(viewerId && post.reposts && post.reposts.length > 0),
      isMine: Boolean(viewerId && post.author.id === viewerId),
    };
  }
}
