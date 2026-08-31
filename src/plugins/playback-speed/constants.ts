export const MIN_PLAYBACK_SPEED = 0.07;
export const MAX_PLAYBACK_SPEED = 16;
export const PLAYBACK_SPEED_STEP = 0.005;

/** The in-menu slider covers the useful range, not the full rate the video accepts. */
export const MIN_SLIDER_SPEED = 0;
export const MAX_SLIDER_SPEED = 2;

const STEPS_PER_UNIT = 1 / PLAYBACK_SPEED_STEP;

/** Integer arithmetic, or repeated 0.005 additions surface as 1.0050000000000001. */
export const snapToStep = (speed: number) =>
  Math.round(speed * STEPS_PER_UNIT) / STEPS_PER_UNIT;
