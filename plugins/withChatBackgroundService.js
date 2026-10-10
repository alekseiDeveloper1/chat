const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const SERVICE_NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

module.exports = function withChatBackgroundService(config) {
  return withAndroidManifest(config, (mod) => {
    AndroidConfig.Permissions.ensurePermissions(mod.modResults, [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING',
      'android.permission.WAKE_LOCK',
    ]);

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    const services = application.service ?? [];
    let service = services.find((entry) => entry.$['android:name'] === SERVICE_NAME);
    if (!service) {
      service = { $: { 'android:name': SERVICE_NAME } };
      services.push(service);
    }
    service.$['android:foregroundServiceType'] = 'remoteMessaging';
    service.$['android:exported'] = 'false';
    service.$['android:stopWithTask'] = 'false';
    application.service = services;
    return mod;
  });
};
