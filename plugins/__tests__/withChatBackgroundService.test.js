/** @jest-environment node */
const { it, expect } = require('@jest/globals');
const withChatBackgroundService = require('../withChatBackgroundService');

const SERVICE_NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

async function applyPlugin(manifest) {
  const config = withChatBackgroundService({ name: 'Chat', slug: 'chat' });
  const result = await config.mods.android.manifest({
    ...config,
    modResults: manifest,
    modRequest: { projectRoot: '', platformProjectRoot: '', platform: 'android', modName: 'manifest' },
  });
  return result.modResults;
}

it('adds Android 14 service requirements once and keeps unrelated services and permissions', async () => {
  const manifest = {
    manifest: {
      'uses-permission': [{ $: { 'android:name': 'android.permission.INTERNET' } }],
      application: [{
        $: { 'android:name': '.MainApplication' },
        service: [{ $: { 'android:name': '.ExistingService' } }],
      }],
    },
  };
  const once = await applyPlugin(manifest);
  const snapshot = JSON.parse(JSON.stringify(once));
  const twice = await applyPlugin(once);
  expect(twice).toEqual(snapshot);
  expect(twice.manifest.application[0].service).toEqual([
    { $: { 'android:name': '.ExistingService' } },
    { $: {
      'android:name': SERVICE_NAME,
      'android:foregroundServiceType': 'remoteMessaging',
      'android:exported': 'false',
      'android:stopWithTask': 'false',
    } },
  ]);
  expect(twice.manifest['uses-permission'].map((permission) => permission.$['android:name'])).toEqual([
    'android.permission.INTERNET',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING',
    'android.permission.WAKE_LOCK',
  ]);
});

it('updates the existing service to survive task removal instead of duplicating it', async () => {
  const manifest = {
    manifest: {
      application: [{
        $: { 'android:name': '.MainApplication' },
        service: [{ $: {
          'android:name': SERVICE_NAME,
          'android:foregroundServiceType': 'dataSync',
          'android:stopWithTask': 'true',
        } }],
      }],
    },
  };
  const result = await applyPlugin(manifest);
  expect(result.manifest.application[0].service).toHaveLength(1);
  expect(result.manifest.application[0].service[0].$['android:foregroundServiceType']).toBe('remoteMessaging');
  expect(result.manifest.application[0].service[0].$['android:stopWithTask']).toBe('false');
});
