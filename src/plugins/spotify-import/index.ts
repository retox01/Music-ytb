import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { backend } from './main';

export default createPlugin({
  name: () => t('plugins.spotify-import.name'),
  description: () => t('plugins.spotify-import.description'),
  restartNeeded: false,
  config: {
    enabled: false,
  },
  backend,
});
