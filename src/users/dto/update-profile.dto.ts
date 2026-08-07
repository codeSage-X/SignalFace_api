import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(160, { message: 'Bio must be at most 160 characters' })
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255, { message: 'Link must be at most 255 characters' })
  websiteUrl?: string;
}
