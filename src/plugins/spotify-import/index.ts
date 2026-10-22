import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { backend } from './main';

export default createPlugin({
  name: () => t('plugins.spotify-import.name'),
  description: () => t('plugins.spotify-import.description'),
  restartNeeded: false,
  config: {
    // Default to on: a plugin that's off by default is invisible until
    // someone finds the Plugins menu — the exact "I enabled it and nothing
    // happened" confusion the widget had before its own default flipped.
    enabled: true,
  },
  backend,
});
