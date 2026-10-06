import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { ChatEngine } from '@/domain/services/ChatEngine';
import { ChatNotifications } from '@/data/notifications/ChatNotifications';
import { ChatBackgroundService } from '@/data/notifications/ChatBackgroundService';
import { appLogger } from '@/shared/logging/AppLogger';
import { useChat } from '../useChat';

jest.mock('@/domain/services/ChatEngine', () => ({ ChatEngine: jest.fn() }));
jest.mock('@/data/crypto/AESCryptoService', () => ({ AESCryptoService: jest.fn() }));
jest.mock('@/data/database/SQLiteMessageRepository', () => ({ SQLiteMessageRepository: jest.fn() }));
jest.mock('@/data/network/WebRTCNetworkService', () => ({ WebRTCNetworkService: jest.fn() }));
jest.mock('@/data/notifications/ChatNotifications', () => ({ ChatNotifications: jest.fn() }));
jest.mock('@/data/notifications/ChatBackgroundService', () => ({ ChatBackgroundService: jest.fn() }));

const attachment = { name: 'notes.txt', mimeType: 'text/plain', size: 5, base64: 'aGVsbG8=' };

describe('useChat', () => {
  let renderer;
  let chat;
  let engine;
  let notifications;
  let backgroundService;

  function Harness() {
    chat = useChat();
    return null;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    global.IS_REACT_ACT_ENVIRONMENT = true;
    for (const level of ['debug', 'info', 'warn', 'error']) {
      jest.spyOn(console, level).mockImplementation(() => {});
    }
    appLogger.clear();
    engine = {
      joinRoom: jest.fn(async (_room, _password, _onMessage, onStatus) => onStatus('connected')),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      getHistory: jest.fn().mockResolvedValue([]),
      disconnect: jest.fn(),
    };
    notifications = {
      prepare: jest.fn().mockResolvedValue(undefined),
      showMessage: jest.fn().mockResolvedValue(undefined),
    };
    backgroundService = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    };
    ChatEngine.mockImplementation(() => engine);
    ChatNotifications.mockImplementation(() => notifications);
    ChatBackgroundService.mockImplementation(() => backgroundService);
    await act(async () => { renderer = create(<Harness />); });
  });

  afterEach(async () => {
    if (renderer) await act(async () => { renderer.unmount(); });
    jest.restoreAllMocks();
  });

  describe('sending', () => {
    beforeEach(async () => {
      await act(async () => { await chat.joinRoom('room', 'password'); });
    });

  it('sends file-only messages and reports successful delivery', async () => {
    let result;
    await act(async () => { result = await chat.sendMessage('', attachment); });

    expect(result).toBe(true);
    expect(engine.sendMessage).toHaveBeenCalledWith('', attachment);
    expect(chat.isSending).toBe(false);
  });

  it('reports failure without exposing arbitrary send errors in the log', async () => {
    engine.sendMessage.mockRejectedValue(new Error('sensitive file content'));
    let result;
    await act(async () => { result = await chat.sendMessage('Подпись', attachment); });

    expect(result).toBe(false);
    expect(chat.isSending).toBe(false);
    expect(chat.connectionAlerts[0]).toMatchObject({
      message: 'Не удалось отправить сообщение',
      errorMessage: undefined,
      visibleToUser: true,
    });
  });

  it('prevents a second send while the first is still pending', async () => {
    let finishSend;
    engine.sendMessage.mockImplementation(() => new Promise((resolve) => { finishSend = resolve; }));
    let sending;
    let duplicate;
    await act(async () => {
      sending = chat.sendMessage('', attachment);
      duplicate = await chat.sendMessage('', attachment);
    });

    expect(duplicate).toBe(false);
    expect(engine.sendMessage).toHaveBeenCalledTimes(1);
    expect(chat.isSending).toBe(true);

    await act(async () => { finishSend(); await sending; });
    expect(chat.isSending).toBe(false);
  });

  it('ignores a previous room send completing while a new room send is pending', async () => {
    let finishFirst;
    let finishSecond;
    engine.sendMessage
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve; }));
    let firstSend;
    let secondSend;
    await act(async () => { firstSend = chat.sendMessage('', attachment); });
    await act(async () => { chat.disconnectRoom(); });
    await act(async () => { await chat.joinRoom('another room', 'password'); });
    await act(async () => { secondSend = chat.sendMessage('', attachment); });

    let firstResult;
    await act(async () => { finishFirst(); firstResult = await firstSend; });
    expect(firstResult).toBe(false);
    expect(chat.isSending).toBe(true);

    let secondResult;
    await act(async () => { finishSecond(); secondResult = await secondSend; });
    expect(secondResult).toBe(true);
    expect(chat.isSending).toBe(false);
  });
  });

  describe('notifications and background reception', () => {
    const incomingMessage = {
      id: 'incoming', roomId: 'room-id', text: 'New message', senderId: 'peer', timestamp: 1,
    };

    it('waits for notification preparation and background startup before connecting', async () => {
      let finishPreparation;
      let finishBackgroundStart;
      notifications.prepare.mockImplementationOnce(() => new Promise((resolve) => { finishPreparation = resolve; }));
      backgroundService.start.mockImplementationOnce(() => new Promise((resolve) => { finishBackgroundStart = resolve; }));
      let joining;
      await act(async () => { joining = chat.joinRoom('room', 'password'); });

      expect(notifications.prepare).toHaveBeenCalledTimes(1);
      expect(backgroundService.start).not.toHaveBeenCalled();
      expect(engine.joinRoom).not.toHaveBeenCalled();
      expect(chat.isJoining).toBe(true);

      await act(async () => { finishPreparation(); });
      expect(backgroundService.start).toHaveBeenCalledTimes(1);
      expect(engine.joinRoom).not.toHaveBeenCalled();

      await act(async () => { finishBackgroundStart(); await joining; });
      expect(engine.joinRoom).toHaveBeenCalledWith('room', 'password', expect.any(Function), expect.any(Function));
      expect(chat.inRoom).toBe(true);
      expect(chat.isJoining).toBe(false);
    });

    it('shows the incoming message while refreshing history independently', async () => {
      await act(async () => { await chat.joinRoom('room', 'password'); });
      let finishNotification;
      notifications.showMessage.mockImplementationOnce(() => new Promise((resolve) => { finishNotification = resolve; }));
      engine.getHistory.mockResolvedValueOnce([incomingMessage]);
      const onIncoming = engine.joinRoom.mock.calls[0][2];

      await act(async () => { onIncoming(incomingMessage); });
      expect(notifications.showMessage).toHaveBeenCalledWith(incomingMessage, expect.any(Function));
      expect(notifications.showMessage.mock.calls[0][1]()).toBe(true);
      expect(chat.messages).toEqual([incomingMessage]);
      await act(async () => { finishNotification(); });
    });

    it('still shows the incoming notification when refreshing history fails', async () => {
      await act(async () => { await chat.joinRoom('room', 'password'); });
      engine.getHistory.mockRejectedValueOnce(new Error('Database busy'));
      const onIncoming = engine.joinRoom.mock.calls[0][2];

      await act(async () => { onIncoming(incomingMessage); });
      expect(notifications.showMessage).toHaveBeenCalledWith(incomingMessage, expect.any(Function));
      expect(chat.connectionAlerts).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: 'Не удалось обновить историю сообщений', visibleToUser: true }),
      ]));
    });

    it('does not notify when loading history or sending a message', async () => {
      engine.getHistory.mockResolvedValue([incomingMessage]);
      await act(async () => { await chat.joinRoom('room', 'password'); });
      expect(chat.messages).toEqual([incomingMessage]);
      await act(async () => { await chat.sendMessage('Outgoing message'); });

      expect(engine.sendMessage).toHaveBeenCalledWith('Outgoing message', undefined);
      expect(notifications.showMessage).not.toHaveBeenCalled();
    });

    it('invalidates pending notifications and ignores incoming callbacks after leaving', async () => {
      await act(async () => { await chat.joinRoom('room', 'password'); });
      const onIncoming = engine.joinRoom.mock.calls[0][2];
      await act(async () => { onIncoming(incomingMessage); });
      const isCurrentRoom = notifications.showMessage.mock.calls[0][1];
      expect(isCurrentRoom()).toBe(true);

      await act(async () => { chat.disconnectRoom(); });
      notifications.showMessage.mockClear();
      engine.getHistory.mockClear();
      await act(async () => { onIncoming(incomingMessage); });

      expect(isCurrentRoom()).toBe(false);
      expect(notifications.showMessage).not.toHaveBeenCalled();
      expect(engine.getHistory).not.toHaveBeenCalled();
      expect(backgroundService.stop).toHaveBeenCalledTimes(1);
      expect(chat.inRoom).toBe(false);
    });

    it('stops background reception and ignores incoming callbacks after unmounting', async () => {
      await act(async () => { await chat.joinRoom('room', 'password'); });
      const onIncoming = engine.joinRoom.mock.calls[0][2];
      await act(async () => { renderer.unmount(); renderer = null; });
      engine.getHistory.mockClear();
      await act(async () => { onIncoming(incomingMessage); });

      expect(backgroundService.stop).toHaveBeenCalledTimes(1);
      expect(engine.disconnect).toHaveBeenCalledWith({ navigateHome: false, reason: 'screen_unmount' });
      expect(notifications.showMessage).not.toHaveBeenCalled();
      expect(engine.getHistory).not.toHaveBeenCalled();
    });

    it('keeps background reception during reconnection and stops it on terminal failure', async () => {
      await act(async () => { await chat.joinRoom('room', 'password'); });
      const onStatus = engine.joinRoom.mock.calls[0][3];

      await act(async () => { onStatus('connecting'); });
      expect(chat.connectionStatus).toBe('connecting');
      expect(backgroundService.stop).not.toHaveBeenCalled();

      await act(async () => { onStatus('failed'); });
      expect(chat.connectionStatus).toBe('failed');
      expect(backgroundService.stop).toHaveBeenCalledTimes(1);
    });

    it('stops background reception if joining fails', async () => {
      engine.joinRoom.mockRejectedValueOnce(new Error('Connection failed'));
      await act(async () => { await chat.joinRoom('room', 'password'); });

      expect(backgroundService.start).toHaveBeenCalledTimes(1);
      expect(backgroundService.stop).toHaveBeenCalledTimes(1);
      expect(engine.disconnect).toHaveBeenCalledWith({ navigateHome: false, reason: 'join_failed' });
      expect(chat.inRoom).toBe(false);
      expect(chat.connectionStatus).toBe('failed');
      expect(chat.isJoining).toBe(false);
    });

    it('does not start background reception or connect after leaving while permission is pending', async () => {
      let finishPreparation;
      notifications.prepare.mockImplementationOnce(() => new Promise((resolve) => { finishPreparation = resolve; }));
      let joining;
      await act(async () => { joining = chat.joinRoom('room', 'password'); });
      await act(async () => { chat.disconnectRoom(); });
      await act(async () => { finishPreparation(); await joining; });

      expect(backgroundService.start).not.toHaveBeenCalled();
      expect(engine.joinRoom).not.toHaveBeenCalled();
      expect(backgroundService.stop).toHaveBeenCalledTimes(1);
      expect(chat.inRoom).toBe(false);
      expect(chat.isJoining).toBe(false);
    });

    it('keeps normal chat available and warns if background startup fails', async () => {
      backgroundService.start.mockRejectedValueOnce(new Error('Foreground service unavailable'));
      await act(async () => { await chat.joinRoom('room', 'password'); });

      expect(engine.joinRoom).toHaveBeenCalledTimes(1);
      expect(chat.inRoom).toBe(true);
      expect(chat.connectionStatus).toBe('connected');
      expect(chat.connectionAlerts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          message: 'Фоновая служба не запущена. При сворачивании прием сообщений может остановиться.',
          visibleToUser: true,
        }),
      ]));
    });
  });
});
