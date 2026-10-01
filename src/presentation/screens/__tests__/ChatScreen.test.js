import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { Button, Linking, Text, TextInput } from 'react-native';
import { ChatScreen } from '../ChatScreen';
import { useChat } from '@/presentation/hooks/useChat';
import { openAttachment, pickAttachment } from '@/data/files/ChatAttachments';

jest.mock('@/presentation/hooks/useChat', () => ({ useChat: jest.fn() }));
jest.mock('@/data/files/ChatAttachments', () => ({
  AttachmentError: class AttachmentError extends Error {},
  pickAttachment: jest.fn(),
  openAttachment: jest.fn(),
}));

const attachment = { name: 'notes.txt', mimeType: 'text/plain', size: 5, base64: 'aGVsbG8=' };

describe('ChatScreen attachment drafts', () => {
  let screen;
  let chat;

  const button = (title) => screen.root.findAllByType(Button).find((item) => item.props.title === title);
  const input = () => screen.root.findByType(TextInput);

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
});
