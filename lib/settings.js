'use strict';

/** Must match "pluginAlias" in config.schema.json and "homebridge.platforms" in package.json. */
const PLATFORM_NAME = 'Texecom';

/** Must match "name" in package.json. */
const PLUGIN_NAME = 'homebridge-texecom-full';

const DEFAULT_IP_PORT = 10001;

module.exports = { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_IP_PORT };
