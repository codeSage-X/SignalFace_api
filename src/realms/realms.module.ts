import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { PostsModule } from '../posts/posts.module';
import { RealmsController } from './realms.controller';
import { RealmsService } from './realms.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';

@Module({
  // PostsModule exports PostsService, which serves the realm feed.
  imports: [AuthModule, CloudinaryModule, PostsModule],
  controllers: [RealmsController],
  providers: [RealmsService, JwtAuthGuard, OptionalJwtAuthGuard],
  exports: [RealmsService],
})
export class RealmsModule {}
