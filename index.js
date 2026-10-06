'use strict';

const { PLATFORM_NAME } = require('./lib/settings');
const { TexecomPlatform } = require('./lib/platform');

/** @param {import('homebridge').API} api */
module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, TexecomPlatform);
};
