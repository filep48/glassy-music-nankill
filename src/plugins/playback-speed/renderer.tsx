import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';

import { t } from '@/i18n';
import {
  isMusicOrVideoTrack,
  isPlayerMenu,
} from '@/plugins/utils/renderer/check';
import { getSongMenu } from '@/providers/dom-elements';

import { PlaybackSpeedSlider } from './components/slider';
import { SpeedControl } from './components/speed-control';
import {
  MAX_PLAYBACK_SPEED,
  MIN_PLAYBACK_SPEED,
  PLAYBACK_SPEED_STEP,
  snapToStep,
} from './constants';

import type { PlaybackSpeedPluginConfig } from './index';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

/**
 * Chromium already defaults `preservesPitch` to true, so speed changes keep the
 * original key. Setting it explicitly makes that intentional rather than inherited,
 * and re-asserts it on every rate change in case something else flips it.
 *
 * With it true, this plugin and pitch-shift are independent: Chromium's WSOLA hands
 * the pitch worklet samples that are already pitch-correct, so speed and key can be
 * set separately. (At extreme rates the two stretchers' artifacts compound.)
 */
const applyRateSettings = (videoElement: HTMLVideoElement) => {
  const wantsPreservedPitch = !vinylMode();
  if (videoElement.preservesPitch !== wantsPreservedPitch) {
    videoElement.preservesPitch = wantsPreservedPitch;
  }
  if (videoElement.playbackRate !== speed()) {
    videoElement.playbackRate = speed();
  }
};

const forcePlaybackRate = (e: Event) => {
  if (e.target instanceof HTMLVideoElement) {
    applyRateSettings(e.target);
  }
};

const [speed, setSpeed] = createSignal(1);
const [vinylMode, setVinylMode] = createSignal(false);
const sliderContainer = document.createElement('div');
const controlContainer = document.createElement('div');
// `contents` keeps the wrapper out of the player bar's flex layout.
controlContainer.style.display = 'contents';

const PLAYER_BAR_SELECTOR = '.right-controls-buttons';

let playerBarObserver: MutationObserver | null = null;
let disposeControl: (() => void) | null = null;
let showControl = true;

/**
 * The signal is the single source of truth, so both entry points go through the
 * setter's updater form.
 */
const commit = (compute: (previous: number) => number) => {
  setSpeed((previous) =>
    snapToStep(
      Math.min(
        Math.max(compute(previous), MIN_PLAYBACK_SPEED),
        MAX_PLAYBACK_SPEED,
      ),
    ),
  );

  const videoElement = document.querySelector<HTMLVideoElement>('video');
  if (videoElement) applyRateSettings(videoElement);
};

const applySpeed = (value: number) => commit(() => (isNaN(value) ? 1 : value));
const nudgeSpeed = (delta: number) => commit((previous) => previous + delta);

const mountControl = () => {
  const playerBar = document.querySelector(PLAYER_BAR_SELECTOR);
  if (!playerBar || playerBar.contains(controlContainer)) return;

  disposeControl ??= render(
    () => (
      <SpeedControl
        label={t('plugins.playback-speed.templates.button')}
        max={MAX_PLAYBACK_SPEED}
        min={MIN_PLAYBACK_SPEED}
        onChange={applySpeed}
        resetLabel={t('plugins.playback-speed.templates.reset')}
        speed={speed()}
        step={PLAYBACK_SPEED_STEP}
      />
    ),
    controlContainer,
  );

  playerBar.append(controlContainer);
};

const unmountControl = () => {
  controlContainer.remove();
  disposeControl?.();
  disposeControl = null;
};

// The player bar is re-rendered on navigation, so a one-shot mount does not survive.
const observePlayerBar = () => {
  mountControl();
  playerBarObserver ??= new MutationObserver(() => mountControl());
  playerBarObserver.observe(document.body, { childList: true, subtree: true });
};

const unobservePlayerBar = () => {
  playerBarObserver?.disconnect();
  playerBarObserver = null;
  unmountControl();
};

export const onConfigChange = (newConfig: PlaybackSpeedPluginConfig) => {
  setVinylMode(newConfig.vinylMode);

  const videoElement = document.querySelector<HTMLVideoElement>('video');
  if (videoElement) applyRateSettings(videoElement);

  if (newConfig.showPlayerBarControl === showControl) return;
  showControl = newConfig.showPlayerBarControl;

  if (showControl) observePlayerBar();
  else unobservePlayerBar();
};

export const onPlayerApiReady = async (
  _playerApi: MusicPlayer,
  { getConfig }: RendererContext<PlaybackSpeedPluginConfig>,
) => {
  const config = await getConfig();
  setVinylMode(config.vinylMode);
  showControl = config.showPlayerBarControl;

  const observePopupContainer = () => {
    render(
      () => (
        <PlaybackSpeedSlider
          onImmediateValueChanged={(e) =>
            applySpeed(Number(e.detail.value ?? MIN_PLAYBACK_SPEED))
          }
          onWheel={(e) => {
            e.preventDefault();
            nudgeSpeed(
              e.deltaY < 0 ? PLAYBACK_SPEED_STEP : -PLAYBACK_SPEED_STEP,
            );
          }}
          speed={speed()}
          title={t('plugins.playback-speed.templates.button')}
        />
      ),
      sliderContainer,
    );

    const observer = new MutationObserver(() => {
      const menu = getSongMenu();

      if (
        menu &&
        !menu.contains(sliderContainer) &&
        isMusicOrVideoTrack() &&
        isPlayerMenu(menu)
      ) {
        menu.prepend(sliderContainer);
      }
    });

    const popupContainer = document.querySelector('ytmusic-popup-container');
    if (popupContainer) {
      observer.observe(popupContainer, {
        childList: true,
        subtree: true,
      });
    }
  };

  const observeVideo = () => {
    const video = document.querySelector<HTMLVideoElement>('video');
    if (video) {
      video.addEventListener('ratechange', forcePlaybackRate);
      video.addEventListener('peard:src-changed', forcePlaybackRate);
    }
  };

  observePopupContainer();
  observeVideo();

  if (showControl) observePlayerBar();
};

export const onUnload = () => {
  const video = document.querySelector<HTMLVideoElement>('video');
  if (video) {
    video.removeEventListener('ratechange', forcePlaybackRate);
    video.removeEventListener('peard:src-changed', forcePlaybackRate);
  }
  getSongMenu()?.removeChild(sliderContainer);
  unobservePlayerBar();
};
