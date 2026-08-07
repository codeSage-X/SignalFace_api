export const STARTING_BALANCE = 10_000;
export const SIGNUP_BONUS = 10_000;
export const REFERRAL_BONUS = 500;

export const DEFAULT_SCORE_WEIGHTS = {
  wFollowers: 0.01,
  wLikes: 0.01,
  wComments: 0.02,
  wShares: 0.03,
  wGrowth: 1.0,
} as const;

export const DEFAULT_PRICE_COEFFICIENTS = {
  priceBase: 1.0,
  priceK: 0.1,
} as const;

// Blend factor for price smoothing: newPrice = ALPHA * computed + (1 - ALPHA) * prevPrice
export const PRICE_SMOOTHING_ALPHA = 0.7;

export const PULSE_INTERVAL_MS = 15 * 60 * 1000;

export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_DAYS = 30;

export const EMAIL_VERIFY_TOKEN_TTL_HOURS = 24;
export const PASSWORD_RESET_TOKEN_TTL_HOURS = 1;

export const EMAIL_OTP_TTL_MINUTES = 10;
export const PASSWORD_RESET_OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
