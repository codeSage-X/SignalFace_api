import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RealmCategory } from '@signal-face/db';

/**
 * The creator sign-up form. `name` and `category` are the only required
 * fields — everything else the creator fills in later from their page.
 */
export class CreateRealmDto {
  @IsString()
  @MinLength(2, { message: 'Your realm name needs at least 2 characters' })
  @MaxLength(50, { message: 'Realm names are limited to 50 characters' })
  name!: string;

  @IsEnum(RealmCategory, { message: 'Pick a category for your realm' })
  category!: RealmCategory;

  /**
   * Optional — derived from the name when omitted. Lowercase letters, numbers
   * and underscores only, so it stays safe in a URL.
   */
  @IsOptional()
  @IsString()
  @MinLength(3, { message: 'Handles need at least 3 characters' })
  @MaxLength(30, { message: 'Handles are limited to 30 characters' })
  @Matches(/^[a-z0-9_]+$/, {
    message: 'Handles can only contain lowercase letters, numbers and underscores',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120, { message: 'Taglines are limited to 120 characters' })
  tagline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Descriptions are limited to 1000 characters' })
  description?: string;

  @IsOptional()
  @IsUrl({}, { message: 'Enter a valid website URL' })
  websiteUrl?: string;
}
