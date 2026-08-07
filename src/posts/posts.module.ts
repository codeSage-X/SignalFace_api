import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';

@Module({
  imports: [AuthModule, CloudinaryModule],
  controllers: [PostsController],
  providers: [PostsService, OptionalJwtAuthGuard],
  exports: [PostsService],
})
export class PostsModule {}
