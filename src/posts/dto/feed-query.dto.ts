import { IsOptional, IsString, IsInt, IsIn, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

/** Mirrors the RealmCategory enum — posts are categorised by the same vocabulary. */
const POST_CATEGORIES = [
  'MUSIC', 'MOVIE', 'COMEDY', 'SPORTS', 'FASHION', 'BEAUTY', 'GAMING', 'TECH',
  'EDUCATION', 'BUSINESS', 'FOOD', 'TRAVEL', 'ART', 'FITNESS', 'CRYPTO', 'OTHER',
] as const;

export class FeedQueryDto {
  // Id of the last post already seen; results resume immediately after it.
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  // Search term, used by /posts/search. Declared here because the global
  // ValidationPipe runs with `forbidNonWhitelisted`, so a query parameter that
  // isn't on the DTO is rejected outright rather than ignored.
  @IsOptional()
  @IsString()
  q?: string;

  /** Restricts /posts/search to video posts. A query string, so "true"/"false". */
  @IsOptional()
  @IsString()
  videosOnly?: string;

  // Narrows /posts/search to one topic. Used on Explore, where picking a
  // category should narrow the posts as well as the realms.
  @IsOptional()
  @IsIn(POST_CATEGORIES, { message: 'Unsupported category' })
  category?: (typeof POST_CATEGORIES)[number];
}
