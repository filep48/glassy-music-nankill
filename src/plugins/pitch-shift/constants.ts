import type { PluginConfig } from '@/types/plugins';

export type PitchShiftPluginConfig = {
  enabled: boolean;
  showPlayerBarControl: boolean;
  phaseLocking: boolean;
  /** How many steps one semitone is divided into. 1 is chromatic, 3 is third-tones. */
  stepsPerSemitone: number;
} & PluginConfig;

export const DEFAULT_CONFIG: PitchShiftPluginConfig = {
  enabled: false,
  showPlayerBarControl: true,
  phaseLocking: true,
  stepsPerSemitone: 1,
};

/** Inclusive bounds for the semitone parameter. */
export const MIN_SEMITONES = -12;
export const MAX_SEMITONES = 12;

export const STEPS_PER_SEMITONE_OPTIONS = [1, 3];

const FRACTION_GLYPHS: Record<string, string> = {
  '1/3': '⅓',
  '2/3': '⅔',
};

/** `units` counts steps, not semitones: 4 units at 3 steps per semitone is +1⅓. */
export const formatUnits = (units: number, stepsPerSemitone: number) => {
  if (units === 0) return '0';

  const magnitude = Math.abs(units);
  const whole = Math.floor(magnitude / stepsPerSemitone);
  const rest = magnitude % stepsPerSemitone;
  const ratio = `${rest}/${stepsPerSemitone}`;
  const glyph = FRACTION_GLYPHS[ratio];
  const fraction =
    rest === 0 ? '' : (glyph ?? (whole === 0 ? ratio : ` ${ratio}`));

  return `${units > 0 ? '+' : '-'}${whole === 0 && fraction ? '' : whole}${fraction}`;
};
