import { IsString, IsNotEmpty, MaxLength, IsOptional } from 'class-validator';

export class CreateCommentDto {
  @IsString()
  @IsNotEmpty({ message: 'Comment cannot be empty' })
  @MaxLength(1000, { message: 'Comments are limited to 1000 characters' })
  body: string;

  // Id of the comment being replied to. Omit for a top-level comment.
  @IsOptional()
  @IsString()
  parentId?: string;
}
