import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePostDto {
  // Optional because a post can be media-only. The service rejects the
  // case where both body and files are empty.
  @IsOptional()
  @IsString()
  @MaxLength(5000, { message: 'Posts are limited to 5000 characters' })
  body?: string;

  @IsOptional()
  @IsString()
  realmId?: string;
}
