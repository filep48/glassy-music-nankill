import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { onConfigChange, onPlayerApiReady, onUnload } from './renderer';
import style from './style.css?inline';

import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

export type PlaybackSpeedPluginConfig = {
  enabled: boolean;
  /**
   * Off (the default) keeps the original key at any speed, which is what Chromium
   * does by default. On gives the turntable behaviour, where slowing the track down
   * also drops its pitch.
   */
  vinylMode: boolean;
  showPlayerBarControl: boolean;
};

export default createPlugin({
  name: () => t('plugins.playback-speed.name'),
  description: () => t('plugins.playback-speed.description'),
  restartNeeded: false,
  config: {
    enabled: false,
    vinylMode: false,
    showPlayerBarControl: true,
  } as PlaybackSpeedPluginConfig,
  stylesheets: [style],
  menu: async ({
    getConfig,
    setConfig,
  }: MenuContext<PlaybackSpeedPluginConfig>): Promise<MenuTemplate> => {
    const config = await getConfig();

    return [
      {
        label: t('plugins.playback-speed.menu.vinyl-mode'),
        type: 'checkbox',
        checked: config.vinylMode,
        click: () => setConfig({ vinylMode: !config.vinylMode }),
      },
      {
        label: t('plugins.playback-speed.menu.show-player-bar-control'),
        type: 'checkbox',
        checked: config.showPlayerBarControl,
        click: () =>
          setConfig({ showPlayerBarControl: !config.showPlayerBarControl }),
      },
    ];
  },
  renderer: {
    stop: onUnload,
    onPlayerApiReady,
    onConfigChange,
  },
});
