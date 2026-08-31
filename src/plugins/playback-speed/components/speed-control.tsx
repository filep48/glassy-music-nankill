export interface SpeedControlProps {
  speed: number;
  min: number;
  max: number;
  step: number;
  /** Tooltip / accessible name, e.g. "Speed". */
  label: string;
  /** Accessible name for the reset affordance on the readout. */
  resetLabel: string;
  onChange: (speed: number) => void;
}

/**
 * `on:` rather than `onClick`: Solid delegates `onClick` to a single listener on
 * `document`, and inside the player bar the click never gets there.
 */
export const SpeedControl = (props: SpeedControlProps) => (
  <div
    class="playback-speed-control"
    on:wheel={(event: WheelEvent) => {
      event.preventDefault();
      // precise-volume listens on ytmusic-player-bar, an ancestor of this control.
      event.stopPropagation();
      props.onChange(
        props.speed + (event.deltaY < 0 ? props.step : -props.step),
      );
    }}
    role="group"
    title={props.label}
  >
    <button
      aria-label={`${props.label} −${props.step}`}
      class="playback-speed-step"
      disabled={props.speed <= props.min}
      on:click={() => props.onChange(props.speed - props.step)}
      type="button"
    >
      −
    </button>
    <button
      aria-label={props.resetLabel}
      aria-live="polite"
      class="playback-speed-value"
      classList={{ 'playback-speed-active': props.speed !== 1 }}
      on:click={() => props.onChange(1)}
      type="button"
    >
      {props.speed}&#215;
    </button>
    <button
      aria-label={`${props.label} +${props.step}`}
      class="playback-speed-step"
      disabled={props.speed >= props.max}
      on:click={() => props.onChange(props.speed + props.step)}
      type="button"
    >
      +
    </button>
  </div>
);
