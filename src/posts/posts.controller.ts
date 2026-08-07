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
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
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
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FilesInterceptor('media', MAX_FILES, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES },
    }),
  )
  create(
    @Req() req: any,
    @Body() dto: CreatePostDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.postsService.create(req.user.sub, dto, files ?? []);
  }

  @Get('feed')
  @UseGuards(OptionalJwtAuthGuard)
  feed(@Req() req: any, @Query() query: FeedQueryDto) {
    return this.postsService.feed(query, req.user?.sub);
  }

  // Declared before ':id' so "bookmarks" isn't captured as a post id.
  @Get('bookmarks')
  @UseGuards(JwtAuthGuard)
  bookmarks(@Req() req: any, @Query() query: FeedQueryDto) {
    return this.postsService.bookmarks(req.user.sub, query);
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
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  remove(@Req() req: any, @Param('id') id: string) {
    return this.postsService.remove(id, req.user.sub, req.user.role);
  }

  @Post(':id/like')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  toggleLike(@Req() req: any, @Param('id') id: string) {
    return this.postsService.toggleLike(id, req.user.sub);
  }

  @Post(':id/bookmark')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  toggleBookmark(@Req() req: any, @Param('id') id: string) {
    return this.postsService.toggleBookmark(id, req.user.sub);
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
  @UseGuards(JwtAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  pin(@Req() req: any, @Param('id') id: string) {
    return this.postsService.setPinned(id, req.user.sub, true);
  }

  @Delete(':id/pin')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  unpin(@Req() req: any, @Param('id') id: string) {
    return this.postsService.setPinned(id, req.user.sub, false);
  }
}
