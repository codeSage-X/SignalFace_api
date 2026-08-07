import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RealmCategory } from '@signal-face/db';

/**
 * Editable page fields. The handle (`slug`) is deliberately absent — it is in
 * the realm's public URL, so changing it would break every link already shared.
 */
export class UpdateRealmDto {
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Your realm name needs at least 2 characters' })
  @MaxLength(50, { message: 'Realm names are limited to 50 characters' })
  name?: string;

  @IsOptional()
  @IsEnum(RealmCategory, { message: 'Pick a valid category' })
  category?: RealmCategory;

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
