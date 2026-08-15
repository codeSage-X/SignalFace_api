import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
// Only on the routes that publish or interact — reading stays open to an
// account under review, which is what separates a restriction from a ban.
import { ActiveAccountGuard } from '../auth/guards/active-account.guard';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { FeedQueryDto } from './dto/feed-query.dto';

const MAX_FILES = 4;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
  @HttpCode(HttpStatus.CREATED)
  // Two fields rather than one: `cover` carries the author-chosen video frame,
  // which must stay distinguishable from the post's own media.
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'media', maxCount: MAX_FILES },
        { name: 'cover', maxCount: 1 },
      ],
      { storage: memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } },
    ),
  )
  create(
    @Req() req: any,
    @Body() dto: CreatePostDto,
    @UploadedFiles()
    files: { media?: Express.Multer.File[]; cover?: Express.Multer.File[] },
  ) {
    return this.postsService.create(
      req.user.sub,
      dto,
      files?.media ?? [],
      files?.cover?.[0],
    );
  }

  @Get('feed')
  @UseGuards(OptionalJwtAuthGuard)
  feed(@Req() req: any, @Query() query: FeedQueryDto) {
    return this.postsService.feed(query, req.user?.sub);
  }

  // Declared before ':id' so "bookmarks" isn't captured as a post id. The same
  // goes for "reposts" and "liked" below — keep all three above that route.
  @Get('bookmarks')
  @UseGuards(JwtAuthGuard)
  bookmarks(@Req() req: any, @Query() query: FeedQueryDto) {
    return this.postsService.bookmarks(req.user.sub, query);
  }

  @Get('reposts')
  @UseGuards(JwtAuthGuard)
  reposts(@Req() req: any, @Query() query: FeedQueryDto) {
    return this.postsService.reposts(req.user.sub, query);
  }

  @Get('liked')
  @UseGuards(JwtAuthGuard)
  liked(@Req() req: any, @Query() query: FeedQueryDto) {
    return this.postsService.liked(req.user.sub, query);
  }

  // Also above ':id', for the same reason as the collections.
  @Get('search')
  @UseGuards(OptionalJwtAuthGuard)
  search(@Req() req: any, @Query() query: FeedQueryDto) {
    return this.postsService.search(
      query.q ?? '',
      query,
      req.user?.sub,
      query.videosOnly === 'true',
    );
  }

  @Get('user/:username')
  @UseGuards(OptionalJwtAuthGuard)
  byUsername(
    @Req() req: any,
    @Param('username') username: string,
    @Query() query: FeedQueryDto,
  ) {
    return this.postsService.byUsername(username, query, req.user?.sub);
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  findOne(@Req() req: any, @Param('id') id: string) {
    return this.postsService.findOne(id, req.user?.sub);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
  @HttpCode(HttpStatus.OK)
  remove(@Req() req: any, @Param('id') id: string) {
    return this.postsService.remove(id, req.user.sub, req.user.role);
  }

  @Post(':id/like')
  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
  @HttpCode(HttpStatus.OK)
  toggleLike(@Req() req: any, @Param('id') id: string) {
    return this.postsService.toggleLike(id, req.user.sub);
  }

  @Post(':id/bookmark')
  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
  @HttpCode(HttpStatus.OK)
  toggleBookmark(@Req() req: any, @Param('id') id: string) {
    return this.postsService.toggleBookmark(id, req.user.sub);
  }

  @Post(':id/repost')
  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
  @HttpCode(HttpStatus.OK)
  toggleRepost(@Req() req: any, @Param('id') id: string) {
    return this.postsService.toggleRepost(id, req.user.sub);
  }

  @Get(':id/comments')
  comments(@Param('id') id: string, @Query() query: FeedQueryDto) {
    return this.postsService.comments(id, query);
  }

  @Get('comments/:commentId/replies')
  replies(@Param('commentId') commentId: string, @Query() query: FeedQueryDto) {
    return this.postsService.replies(commentId, query);
  }

  @Post(':id/comments')
  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
  @HttpCode(HttpStatus.CREATED)
  addComment(@Req() req: any, @Param('id') id: string, @Body() dto: CreateCommentDto) {
    return this.postsService.addComment(id, req.user.sub, dto);
  }

  @Post(':id/view')
  @HttpCode(HttpStatus.OK)
  registerView(@Param('id') id: string) {
    return this.postsService.registerView(id);
  }

  @Patch(':id/pin')
  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
  @HttpCode(HttpStatus.OK)
  pin(@Req() req: any, @Param('id') id: string) {
    return this.postsService.setPinned(id, req.user.sub, true);
  }

  @Delete(':id/pin')
  @UseGuards(JwtAuthGuard, ActiveAccountGuard)
  @HttpCode(HttpStatus.OK)
  unpin(@Req() req: any, @Param('id') id: string) {
    return this.postsService.setPinned(id, req.user.sub, false);
  }
}
