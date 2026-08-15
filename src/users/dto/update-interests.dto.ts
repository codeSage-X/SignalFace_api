import { ArrayMaxSize, IsArray, IsIn } from 'class-validator';

/** The same vocabulary realms are categorised by, so posts and people match. */
export const INTEREST_CATEGORIES = [
  'MUSIC',
  'MOVIE',
  'COMEDY',
  'SPORTS',
  'FASHION',
  'BEAUTY',
  'GAMING',
  'TECH',
  'EDUCATION',
  'BUSINESS',
  'FOOD',
  'TRAVEL',
  'ART',
  'FITNESS',
  'CRYPTO',
  'OTHER',
] as const;

export class UpdateInterestsDto {
  // Capped: past a point everything matches, and a feed where every post is
  // boosted is the same as one where none is.
  @IsArray()
  @ArrayMaxSize(10, { message: 'Pick up to 10 interests' })
  @IsIn(INTEREST_CATEGORIES, { each: true, message: 'Unsupported interest' })
  interests: (typeof INTEREST_CATEGORIES)[number][];
}
