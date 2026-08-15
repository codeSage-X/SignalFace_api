import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const ASPECT_RATIOS = ['ORIGINAL', '1:1', '4:5', '16:9', '9:16'] as const;

/** Mirrors the RealmCategory enum — posts and realms share one vocabulary. */
export const POST_CATEGORIES = [
  'MUSIC', 'MOVIE', 'COMEDY', 'SPORTS', 'FASHION', 'BEAUTY', 'GAMING', 'TECH',
  'EDUCATION', 'BUSINESS', 'FOOD', 'TRAVEL', 'ART', 'FITNESS', 'CRYPTO', 'OTHER',
] as const;

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

  /** How the author framed the post. Absent means the media's own dimensions. */
  @IsOptional()
  @IsIn(ASPECT_RATIOS, { message: 'Unsupported aspect ratio' })
  aspectRatio?: (typeof ASPECT_RATIOS)[number];

  /**
   * What the post is about. Chosen by the author; when omitted it is inferred
   * from the realm it is published under, or the author's own realm.
   *
   * Without this, a post by someone who runs no realm had no topic at all and
   * could never be found by category.
   */
  @IsOptional()
  @IsIn(POST_CATEGORIES, { message: 'Unsupported category' })
  category?: (typeof POST_CATEGORIES)[number];
}
