import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Cursor pagination for the followers / following lists. */
export class FollowQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  // Search term, used by /users/search. Declared here because the global
  // ValidationPipe runs with `forbidNonWhitelisted`, so a query parameter that
  // isn't on the DTO is rejected outright rather than ignored.
  @IsOptional()
  @IsString()
  q?: string;
}
