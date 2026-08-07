import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { RealmCategory } from '@signal-face/db';

/** Directory search: free-text query plus an optional category filter. */
export class RealmQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  q?: string;

  @IsOptional()
  @IsEnum(RealmCategory)
  category?: RealmCategory;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/** Range selector for the creator dashboard's performance chart. */
export class DashboardQueryDto {
  @IsOptional()
  @IsEnum(['7D', '30D', '90D', '1Y'] as const, {
    message: 'Range must be one of 7D, 30D, 90D, 1Y',
  })
  range?: '7D' | '30D' | '90D' | '1Y';
}
