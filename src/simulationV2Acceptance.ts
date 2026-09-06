export const STRENGTH_RESPONSE_DIFFERENTIALS = [-10, -5, 0, 5, 10] as const;

export const STRENGTH_RESPONSE_ACCEPTANCE_BANDS = {
  0: { minimum: 0.46, maximum: 0.54 },
  5: { minimum: 0.58, maximum: 0.68 },
  10: { minimum: 0.68, maximum: 0.80 },
} as const;

export type StrengthResponseAcceptanceBand = {
  minimum: number;
  maximum: number;
  inclusive: true;
};

export function strengthResponseAcceptanceBand(
  differential: number,
): StrengthResponseAcceptanceBand | null {
  const band = STRENGTH_RESPONSE_ACCEPTANCE_BANDS[
    differential as keyof typeof STRENGTH_RESPONSE_ACCEPTANCE_BANDS
  ];
  return band ? { ...band, inclusive: true } : null;
}

export function passesStrengthResponseBand(
  winRate: number,
  band: StrengthResponseAcceptanceBand | null,
): boolean | null {
  return band === null ? null : winRate >= band.minimum && winRate <= band.maximum;
}
