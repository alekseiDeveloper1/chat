import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { Button, Linking, Text, TextInput } from 'react-native';
import { ChatScreen } from '../ChatScreen';
import { useChat } from '@/presentation/hooks/useChat';
import { openAttachment, pickAttachment } from '@/data/files/ChatAttachments';
import { useIncomingShares } from '@/presentation/sharing/IncomingShareProvider';

jest.mock('@/presentation/hooks/useChat', () => ({ useChat: jest.fn() }));
jest.mock('@/presentation/sharing/IncomingShareProvider', () => ({ useIncomingShares: jest.fn() }));
jest.mock('@/data/files/ChatAttachments', () => ({
  AttachmentError: class AttachmentError extends Error {},
  pickAttachment: jest.fn(),
  openAttachment: jest.fn(),
}));

const attachment = { name: 'notes.txt', mimeType: 'text/plain', size: 5, base64: 'aGVsbG8=' };

describe('ChatScreen drafts', () => {
  let screen;
  let chat;
  let incoming;

  const button = (title) => screen.root.findAllByType(Button).find((item) => item.props.title === title);
  const input = () => screen.root.findByType(TextInput);
  const sharedButton = (label) => screen.root.findAllByType(Button).find((item) => item.props.accessibilityLabel === label);
  const hasText = (text) => screen.root.findAllByType(Text).some((item) => item.props.children === text);

  beforeEach(async () => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    pickAttachment.mockReset();
    openAttachment.mockReset();
    chat = {
      messages: [],
      connectionStatus: 'connected',
      inRoom: true,
      isJoining: false,
      isSending: false,
      connectionAlerts: [],
      joinRoom: jest.fn(),
      sendMessage: jest.fn().mockResolvedValue(true),
      disconnectRoom: jest.fn(),
      clearConnectionAlerts: jest.fn(),
    };
    useChat.mockImplementation(() => chat);
    incoming = { drafts: [], isImporting: false, removeDraft: jest.fn() };
    useIncomingShares.mockImplementation(() => incoming);
    await act(async () => { screen = create(<ChatScreen />); });
  });

  afterEach(async () => {
    await act(async () => { screen.unmount(); });
    jest.restoreAllMocks();
  });

  it('sends a file without a caption and clears the attachment only after success', async () => {
    let finishSend;
    chat.sendMessage.mockImplementation(() => new Promise((resolve) => { finishSend = resolve; }));
    pickAttachment.mockResolvedValue(attachment);
    await act(async () => { await button('Прикрепить файл').props.onPress(); });
    expect(button('Отправить').props.disabled).toBe(false);

    let sending;
    await act(async () => { sending = button('Отправить').props.onPress(); });
    expect(chat.sendMessage).toHaveBeenCalledWith('', attachment);
    expect(button('Убрать')).toBeDefined();

    await act(async () => { finishSend(true); await sending; });
    expect(button('Убрать')).toBeUndefined();
    expect(button('Отправить').props.disabled).toBe(true);
  });

  it('keeps the caption and file when sending fails', async () => {
    pickAttachment.mockResolvedValue(attachment);
    chat.sendMessage.mockResolvedValue(false);
    await act(async () => {
      input().props.onChangeText('Подпись');
      await button('Прикрепить файл').props.onPress();
    });
    await act(async () => { await button('Отправить').props.onPress(); });

    expect(chat.sendMessage).toHaveBeenCalledWith('Подпись', attachment);
    expect(input().props.value).toBe('Подпись');
    expect(button('Убрать')).toBeDefined();
  });

  it('preserves the current draft when the file picker is cancelled', async () => {
    pickAttachment.mockResolvedValueOnce(attachment).mockResolvedValueOnce(null);
    await act(async () => {
      input().props.onChangeText('Подпись');
      await button('Прикрепить файл').props.onPress();
    });
    await act(async () => { await button('Прикрепить файл').props.onPress(); });
    await act(async () => { await button('Отправить').props.onPress(); });

    expect(chat.sendMessage).toHaveBeenCalledWith('Подпись', attachment);
  });

  it('discards an old picker result after disconnecting and joining again', async () => {
    let finishPick;
    pickAttachment.mockImplementation(() => new Promise((resolve) => { finishPick = resolve; }));
    let picking;
    await act(async () => { picking = button('Прикрепить файл').props.onPress(); });
    expect(button('Отправить').props.disabled).toBe(true);

    await act(async () => {
      button('Разорвать соединение').props.onPress();
      chat = { ...chat, inRoom: false };
      screen.update(<ChatScreen />);
    });
    await act(async () => {
      chat = { ...chat, inRoom: true };
      screen.update(<ChatScreen />);
    });
    await act(async () => { finishPick(attachment); await picking; });

    expect(button('Убрать')).toBeUndefined();
    expect(button('Отправить').props.disabled).toBe(true);
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('opens an attachment and an inline link from received messages', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    openAttachment.mockResolvedValue(undefined);
    await act(async () => {
      chat = {
        ...chat,
        messages: [{ id: 'received', senderId: 'peer', text: 'Ссылка: https://example.com.', attachment }],
      };
      screen.update(<ChatScreen />);
    });

    const fileButton = screen.root.findAll((item) =>
      item.props.accessibilityLabel === 'Открыть файл notes.txt' && typeof item.props.onPress === 'function')[0];
    await act(async () => { await fileButton.props.onPress(); });
    const link = screen.root.findAllByType(Text).find((item) => item.props.accessibilityRole === 'link');
    await act(async () => { await link.props.onPress(); });

    expect(openAttachment).toHaveBeenCalledWith(attachment);
    expect(openURL).toHaveBeenCalledWith('https://example.com');
  });

  it('shows incoming text and files before joining and keeps them when the room opens', async () => {
    incoming.drafts = [{ id: 'shared', text: 'https://example.com', attachment }];
    await act(async () => {
      chat = { ...chat, inRoom: false, connectionStatus: 'disconnected' };
      screen.update(<ChatScreen />);
    });

    expect(hasText('Пересыл из другого приложения')).toBe(true);
    expect(hasText('https://example.com')).toBe(true);
    expect(hasText('notes.txt')).toBe(true);
    expect(sharedButton('Отправить пересыл 1 в комнату').props.disabled).toBe(true);
    await act(async () => { await sharedButton('Отправить пересыл 1 в комнату').props.onPress(); });
    expect(chat.sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      chat = { ...chat, inRoom: true, connectionStatus: 'connected' };
      screen.update(<ChatScreen />);
    });
    expect(sharedButton('Отправить пересыл 1 в комнату').props.disabled).toBe(false);
    expect(hasText('https://example.com')).toBe(true);
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(incoming.removeDraft).not.toHaveBeenCalled();
  });

  it('sends an incoming file only on request and preserves the regular composer draft', async () => {
    pickAttachment.mockResolvedValue(attachment);
    await act(async () => {
      input().props.onChangeText('Мой черновик');
      await button('Прикрепить файл').props.onPress();
    });
    incoming.drafts = [{ id: 'shared', text: 'Пересланная подпись', attachment }];
    await act(async () => { screen.update(<ChatScreen />); });
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(input().props.value).toBe('Мой черновик');

    await act(async () => { await sharedButton('Отправить пересыл 1 в комнату').props.onPress(); });

    expect(chat.sendMessage).toHaveBeenCalledWith('Пересланная подпись', attachment);
    expect(incoming.removeDraft).toHaveBeenCalledWith('shared');
    expect(input().props.value).toBe('Мой черновик');
    expect(button('Убрать')).toBeDefined();
  });

  it('retains the incoming draft when sending fails and allows retry', async () => {
    incoming.drafts = [{ id: 'shared', text: 'Пересланный текст' }];
    chat.sendMessage.mockResolvedValue(false);
    await act(async () => { screen.update(<ChatScreen />); });
    await act(async () => { await sharedButton('Отправить пересыл 1 в комнату').props.onPress(); });

    expect(incoming.removeDraft).not.toHaveBeenCalled();
    expect(hasText('Пересланный текст')).toBe(true);
    expect(sharedButton('Отправить пересыл 1 в комнату').props.disabled).toBe(false);
  });

  it('removes only the sent draft when another share arrives during sending', async () => {
    let finishSend;
    chat.sendMessage.mockImplementation(() => new Promise((resolve) => { finishSend = resolve; }));
    incoming.drafts = [{ id: 'first', text: 'Первый' }];
    await act(async () => { screen.update(<ChatScreen />); });
    let sending;
    await act(async () => { sending = sharedButton('Отправить пересыл 1 в комнату').props.onPress(); });
    incoming.drafts = [...incoming.drafts, { id: 'second', text: 'Второй' }];
    await act(async () => { screen.update(<ChatScreen />); });

    expect(sharedButton('Убрать пересыл 1').props.disabled).toBe(true);
    expect(sharedButton('Отправить пересыл 2 в комнату').props.disabled).toBe(true);
    await act(async () => { await sharedButton('Отправить пересыл 2 в комнату').props.onPress(); });
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);

    await act(async () => { finishSend(true); await sending; });
    expect(incoming.removeDraft).toHaveBeenCalledTimes(1);
    expect(incoming.removeDraft).toHaveBeenCalledWith('first');
    expect(hasText('Второй')).toBe(true);
  });

  it('does not remove an incoming draft after a send finishes in an old room', async () => {
    let finishSend;
    chat.sendMessage.mockImplementation(() => new Promise((resolve) => { finishSend = resolve; }));
    incoming.drafts = [{ id: 'shared', text: 'Текст' }];
    await act(async () => { screen.update(<ChatScreen />); });
    let sending;
    await act(async () => { sending = sharedButton('Отправить пересыл 1 в комнату').props.onPress(); });

    await act(async () => {
      button('Разорвать соединение').props.onPress();
      chat = { ...chat, inRoom: false, connectionStatus: 'disconnected' };
      screen.update(<ChatScreen />);
    });
    await act(async () => { finishSend(true); await sending; });

    expect(incoming.removeDraft).not.toHaveBeenCalled();
    expect(hasText('Текст')).toBe(true);
  });

  it('allows discarding an incoming share without sending it', async () => {
    incoming.drafts = [{ id: 'discard', text: 'Текст' }];
    await act(async () => { screen.update(<ChatScreen />); });
    await act(async () => { sharedButton('Убрать пересыл 1').props.onPress(); });

    expect(incoming.removeDraft).toHaveBeenCalledWith('discard');
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('shows import progress and blocks shared sending while the connection is unavailable', async () => {
    incoming = { ...incoming, drafts: [{ id: 'shared', text: 'Текст' }], isImporting: true };
    await act(async () => {
      chat = { ...chat, connectionStatus: 'connecting' };
      screen.update(<ChatScreen />);
    });

    expect(hasText('Получение пересыла...')).toBe(true);
    expect(sharedButton('Отправить пересыл 1 в комнату').props.disabled).toBe(true);
    await act(async () => { await sharedButton('Отправить пересыл 1 в комнату').props.onPress(); });
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });
});
