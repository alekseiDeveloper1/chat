import { ChatNotifications, MESSAGE_CHANNEL_ID } from '@/data/notifications/ChatNotifications';
import type { Message } from '@/domain/entities/Message';
import { appLogger, type AppLogEntry } from '@/shared/logging/AppLogger';

let mockPlatform = 'android';
let mockModuleLoads = 0;
const mockNotifications = {
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  AndroidImportance: { HIGH: 4 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
};

jest.mock('react-native', () => ({
  Platform: { get OS() { return mockPlatform; } },
}));

jest.mock('expo-notifications', () => {
  mockModuleLoads += 1;
  return mockNotifications;
});

const allowed = { granted: true, canAskAgain: true, status: 'granted', expires: 'never' };
const denied = { granted: false, canAskAgain: false, status: 'denied', expires: 'never' };
const incoming: Message = {
  id: 'message-1',
  roomId: 'room-1',
  senderId: 'peer',
  text: 'Привет!',
  timestamp: 1,
};

describe('ChatNotifications', () => {
  let notifications: ChatNotifications;
  let entries: AppLogEntry[];
  let unsubscribe: () => void;

  beforeEach(() => {
    mockPlatform = 'android';
    mockNotifications.setNotificationChannelAsync.mockReset().mockResolvedValue(null);
    mockNotifications.getPermissionsAsync.mockReset().mockResolvedValue(allowed);
    mockNotifications.requestPermissionsAsync.mockReset().mockResolvedValue(allowed);
    mockNotifications.scheduleNotificationAsync.mockReset().mockResolvedValue('notification-1');
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    appLogger.clear();
    entries = [];
    unsubscribe = appLogger.subscribe((entry) => entries.push(entry));
    notifications = new ChatNotifications();
  });

  afterEach(() => {
    unsubscribe();
    jest.restoreAllMocks();
  });

  it('does not load or invoke the native module on web', async () => {
    mockPlatform = 'web';
    await notifications.prepare();
    await notifications.showMessage(incoming, () => true);

    expect(mockModuleLoads).toBe(0);
    expect(mockNotifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.setNotificationChannelAsync).not.toHaveBeenCalled();
    expect(mockNotifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('creates the Android channel before checking and requesting permission', async () => {
    const events: string[] = [];
    mockNotifications.setNotificationChannelAsync.mockImplementation(async () => { events.push('channel'); });
    mockNotifications.getPermissionsAsync.mockImplementation(async () => {
      events.push('check');
      return { ...denied, canAskAgain: true };
    });
    mockNotifications.requestPermissionsAsync.mockImplementation(async () => {
      events.push('request');
      return allowed;
    });

    await notifications.prepare();

    expect(events).toEqual(['channel', 'check', 'request']);
    expect(mockNotifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      MESSAGE_CHANNEL_ID,
      expect.objectContaining({ importance: 4, sound: 'default', lockscreenVisibility: 0 }),
    );
    expect(entries).toEqual([]);
  });

  it('does not repeatedly request a denied permission that cannot be requested again', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue(denied);

    await notifications.prepare();
    await notifications.showMessage(incoming, () => true);

    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(entries).toEqual([expect.objectContaining({
      feature: 'notifications', level: 'warn', visibleToUser: true,
    })]);
  });

  it('reports permission denied after the prompt', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ ...denied, canAskAgain: true });
    mockNotifications.requestPermissionsAsync.mockResolvedValue(denied);

    await notifications.prepare();

    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([expect.objectContaining({ level: 'warn', visibleToUser: true })]);
  });

  it('accepts provisional iOS permission and delivers an immediate notification', async () => {
    mockPlatform = 'ios';
    mockNotifications.getPermissionsAsync.mockResolvedValue({ ...denied, ios: { status: 3 } });

    await notifications.prepare();
    await notifications.showMessage(incoming, () => true);

    expect(mockNotifications.setNotificationChannelAsync).not.toHaveBeenCalled();
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ body: 'Привет!' }),
      trigger: null,
    }));
  });

  it('shows incoming peer messages on the message channel with room navigation data', async () => {
    await notifications.showMessage(incoming, () => true);

    expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: 'chat:room-1:message-1',
      content: {
        title: 'Новое сообщение',
        body: 'Привет!',
        sound: 'default',
        data: { roomId: 'room-1', messageId: 'message-1' },
      },
      trigger: { channelId: MESSAGE_CHANNEL_ID },
    });
  });

  it.each(['me', 'system'])('ignores messages sent by %s', async (senderId) => {
    await notifications.showMessage({ ...incoming, senderId }, () => true);

    expect(mockNotifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('ignores a message for a room that has already been left', async () => {
    await notifications.showMessage(incoming, () => false);

    expect(mockNotifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('discards a message when the user leaves during the permission check', async () => {
    let finishPermissionCheck!: (settings: typeof allowed) => void;
    mockNotifications.getPermissionsAsync.mockReturnValue(new Promise((resolve) => {
      finishPermissionCheck = resolve;
    }));
    let currentRoom = true;
    const pending = notifications.showMessage(incoming, () => currentRoom);
    currentRoom = false;
    finishPermissionCheck(allowed);
    await pending;

    expect(mockNotifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('uses the file name as the preview for an attachment without message text', async () => {
    await notifications.showMessage({
      ...incoming,
      text: '  ',
      attachment: { name: 'report.txt', mimeType: 'text/plain', size: 3, base64: 'YWJj' },
    }, () => true);

    expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ body: 'Файл: report.txt' }),
    }));
  });

  it('limits a long message preview', async () => {
    await notifications.showMessage({ ...incoming, text: `  ${'a'.repeat(200)}  ` }, () => true);

    expect(mockNotifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ body: 'a'.repeat(160) }),
    }));
  });

  it('contains native failures without exposing message text in application logs', async () => {
    const privateText = 'private notification body';
    mockNotifications.scheduleNotificationAsync.mockRejectedValueOnce(new Error(privateText));

    await expect(notifications.showMessage({ ...incoming, text: privateText }, () => true)).resolves.toBeUndefined();

    expect(entries).toEqual([expect.objectContaining({
      feature: 'notifications', level: 'error', visibleToUser: true,
    })]);
    expect(JSON.stringify(entries)).not.toContain(privateText);
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(privateText);
  });

  it('reports native setup failure without aborting room initialization', async () => {
    mockNotifications.setNotificationChannelAsync.mockRejectedValueOnce(new Error('native module unavailable'));

    await expect(notifications.prepare()).resolves.toBeUndefined();

    expect(mockNotifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(entries).toEqual([expect.objectContaining({
      feature: 'notifications', level: 'error', visibleToUser: true,
    })]);
  });
});
