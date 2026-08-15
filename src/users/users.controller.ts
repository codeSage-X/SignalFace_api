import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Req,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateInterestsDto } from './dto/update-interests.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { FollowQueryDto } from './dto/follow-query.dto';

// Guards are applied per-route rather than on the class, because the public
// profile must stay readable without a token.
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@Req() req: any) {
    return this.usersService.getFullProfile(req.user.sub);
  }

  @Patch('me/profile')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  updateProfile(@Req() req: any, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(req.user.sub, dto);
  }

  @Patch('me/account')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  updateAccount(@Req() req: any, @Body() dto: UpdateAccountDto) {
    return this.usersService.updateAccount(req.user.sub, dto);
  }

  @Post('me/avatar')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
          cb(new BadRequestException('Only image files are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadAvatar(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    return this.usersService.uploadAvatar(req.user.sub, file);
  }

  @Patch('me/interests')
  @UseGuards(JwtAuthGuard)
  updateInterests(@Req() req: any, @Body() dto: UpdateInterestsDto) {
    return this.usersService.updateInterests(req.user.sub, dto.interests);
  }

  @Get('me/following')
  @UseGuards(JwtAuthGuard)
  listFollowing(@Req() req: any, @Query() query: FollowQueryDto) {
    return this.usersService.listFollowing(req.user.sub, query);
  }

  @Get('me/followers')
  @UseGuards(JwtAuthGuard)
  listFollowers(@Req() req: any, @Query() query: FollowQueryDto) {
    return this.usersService.listFollowers(req.user.sub, query);
  }

  // Unauthenticated: it backs the sign-up form, where there is no session yet.
  // Above ':username' so "username-available" isn't read as a handle.
  @Get('username-available')
  usernameAvailable(@Query('username') username = '') {
    return this.usersService.usernameAvailable(username);
  }

  // Above ':username', alongside 'search', for the same reason.
  @Get('suggestions')
  @UseGuards(OptionalJwtAuthGuard)
  suggestions(@Req() req: any, @Query('limit') limit?: string) {
    return this.usersService.suggestions(req.user?.sub, limit ? Number(limit) : undefined);
  }

  // Above ':username', or "search" would be looked up as an account.
  @Get('search')
  @UseGuards(OptionalJwtAuthGuard)
  search(@Req() req: any, @Query() query: FollowQueryDto) {
    return this.usersService.search(query.q ?? '', req.user?.sub, query);
  }

  // Declared after the 'me/*' routes so "me" is never read as a username.
  @Get(':username')
  @UseGuards(OptionalJwtAuthGuard)
  getPublicProfile(@Req() req: any, @Param('username') username: string) {
    return this.usersService.getPublicProfile(username, req.user?.sub);
  }

  @Post(':username/follow')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  toggleFollow(@Req() req: any, @Param('username') username: string) {
    return this.usersService.toggleFollow(username, req.user.sub);
  }
}
