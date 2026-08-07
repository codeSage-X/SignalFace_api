import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RealmsService } from './realms.service';
import { PostsService } from '../posts/posts.service';
import { CreateRealmDto } from './dto/create-realm.dto';
import { UpdateRealmDto } from './dto/update-realm.dto';
import { DashboardQueryDto, RealmQueryDto } from './dto/realm-query.dto';
import { FeedQueryDto } from '../posts/dto/feed-query.dto';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const imageUpload = (field: string) =>
  FileInterceptor(field, {
    storage: memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES },
  });

@Controller('realms')
export class RealmsController {
  constructor(
    private readonly realmsService: RealmsService,
    private readonly postsService: PostsService,
  ) {}

  /** Become a creator: creates the page, promotes the account, mints the Signal. */
  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  create(@Req() req: any, @Body() dto: CreateRealmDto) {
    return this.realmsService.becomeCreator(req.user.sub, dto);
  }

  // The literal routes below are declared before ':slug' so they aren't
  // swallowed by the wildcard.

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMine(@Req() req: any) {
    return this.realmsService.getMine(req.user.sub);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  update(@Req() req: any, @Body() dto: UpdateRealmDto) {
    return this.realmsService.update(req.user.sub, dto);
  }

  @Post('me/avatar')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(imageUpload('avatar'))
  uploadAvatar(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    return this.realmsService.uploadImage(req.user.sub, file, 'iconUrl');
  }

  @Post('me/cover')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(imageUpload('cover'))
  uploadCover(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    return this.realmsService.uploadImage(req.user.sub, file, 'coverUrl');
  }

  @Get('me/dashboard')
  @UseGuards(JwtAuthGuard)
  dashboard(@Req() req: any, @Query() query: DashboardQueryDto) {
    return this.realmsService.dashboard(req.user.sub, query.range ?? '30D');
  }

  /** Searchable directory of creator realms. */
  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  list(@Req() req: any, @Query() query: RealmQueryDto) {
    return this.realmsService.list(query, req.user?.sub);
  }

  @Get(':slug')
  @UseGuards(OptionalJwtAuthGuard)
  getBySlug(@Req() req: any, @Param('slug') slug: string) {
    return this.realmsService.getBySlug(slug, req.user?.sub);
  }

  @Get(':slug/posts')
  @UseGuards(OptionalJwtAuthGuard)
  posts(@Req() req: any, @Param('slug') slug: string, @Query() query: FeedQueryDto) {
    return this.postsService.byRealmSlug(slug, query, req.user?.sub);
  }

  @Post(':slug/follow')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  toggleFollow(@Req() req: any, @Param('slug') slug: string) {
    return this.realmsService.toggleFollow(slug, req.user.sub);
  }
}
