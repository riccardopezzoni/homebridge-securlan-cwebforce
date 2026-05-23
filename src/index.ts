import type { API } from 'homebridge';

import { SecurlanPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, SecurlanPlatform);
};
