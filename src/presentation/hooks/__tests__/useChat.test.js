import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { ChatEngine } from '@/domain/services/ChatEngine';
import { appLogger } from '@/shared/logging/AppLogger';
import { useChat } from '../useChat';

jest.mock('@/domain/services/ChatEngine', () => ({ ChatEngine: jest.fn() }));
jest.mock('@/data/crypto/AESCryptoService', () => ({ AESCryptoService: jest.fn() }));
jest.mock('@/data/database/SQLiteMessageRepository', () => ({ SQLiteMessageRepository: jest.fn() }));
jest.mock('@/data/network/WebRTCNetworkService', () => ({ WebRTCNetworkService: jest.fn() }));

const attachment = { name: 'notes.txt', mimeType: 'text/plain', size: 5, base64: 'aGVsbG8=' };

describe('useChat sending', () => {
  let renderer;
  let chat;
  let engine;

  function Harness() {
    chat = useChat();
    return null;
  }

  beforeEach(async () => {
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
    ChatEngine.mockImplementation(() => engine);
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => { await chat.joinRoom('room', 'password'); });
  });

  afterEach(async () => {
    await act(async () => { renderer.unmount(); });
    jest.restoreAllMocks();
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
