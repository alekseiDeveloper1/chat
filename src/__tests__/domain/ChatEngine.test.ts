import { AESCryptoService } from '@/data/crypto/AESCryptoService';
import { FileAttachment, MAX_ATTACHMENT_BYTES, Message } from '@/domain/entities/Message';
import { ChatEngine } from '@/domain/services/ChatEngine';
import { IMessageRepository } from '@/domain/services/IMessageRepository';
import { INetworkService } from '@/domain/services/INetworkService';
import { appLogger } from '@/shared/logging/AppLogger';

jest.mock('@/shared/logging/AppLogger', () => ({
  appLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const attachment: FileAttachment = {
  name: 'секретный-документ.txt',
  mimeType: 'text/plain',
  size: 5,
  base64: 'SGVsbG8=',
};

describe('ChatEngine attachments', () => {
  let engine: ChatEngine;
  let repository: jest.Mocked<IMessageRepository>;
  let network: jest.Mocked<INetworkService>;
  let crypto: AESCryptoService;
  let receive: (payload: string) => void | Promise<void>;
  let onNewMessage: jest.Mock;
  let roomKey: string;
  let roomId: string;

  beforeEach(async () => {
    repository = {
      initialize: jest.fn().mockResolvedValue(undefined),
      saveMessage: jest.fn().mockResolvedValue(undefined),
      getMessagesByRoom: jest.fn().mockResolvedValue([]),
      clearRoomHistory: jest.fn().mockResolvedValue(undefined),
    };
    network = {
      connect: jest.fn().mockResolvedValue(undefined),
      sendData: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      onDataReceived: jest.fn((callback) => { receive = callback; }),
      onStatusChanged: jest.fn(),
    };
    crypto = new AESCryptoService();
    engine = new ChatEngine(crypto, repository, network);
    onNewMessage = jest.fn();
    await engine.joinRoom('room-a', 'password', onNewMessage, jest.fn());
    roomKey = await crypto.generateRoomKey('password');
    roomId = await crypto.generateRoomKey('room-a');
  });

  const packetFrom = (content: unknown, key: string, service: AESCryptoService) => JSON.stringify({
    id: 'remote-file',
    timestamp: 1700000000000,
    version: 2,
    contentType: 'attachment',
    encryptedContent: service.encrypt(JSON.stringify(content), key),
  });

  it.each(['', 'Описание https://example.com/report'])('encrypts and receives a file with caption "%s"', async (text) => {
    await engine.sendMessage(text, attachment);

    const payload = network.sendData.mock.calls[0][0];
    const packet = JSON.parse(payload);
    expect(packet).toMatchObject({ version: 2, contentType: 'attachment' });
    expect(payload).not.toContain(attachment.name);
    expect(payload).not.toContain(attachment.base64);
    expect(payload).not.toContain(attachment.mimeType);
    expect(payload).not.toContain('example.com');
    expect(JSON.parse(crypto.decrypt(packet.encryptedContent, roomKey)!)).toEqual({ text, attachment });
    expect(repository.saveMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      roomId, text, attachment, senderId: 'me',
    }));
    expect(onNewMessage).not.toHaveBeenCalled();

    repository.saveMessage.mockClear();
    await receive(payload);
    expect(repository.saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      roomId, text, attachment, senderId: 'peer',
    }));
    expect(onNewMessage).toHaveBeenCalledTimes(1);
    expect(onNewMessage).toHaveBeenCalledWith(repository.saveMessage.mock.calls[0][0]);
  });

  it('keeps text and links compatible with the existing packet format', async () => {
    const text = 'Ссылка https://example.com/file';
    await engine.sendMessage(text);
    const packet = JSON.parse(network.sendData.mock.calls[0][0]);
    expect(Object.keys(packet).sort()).toEqual(['encryptedText', 'id', 'timestamp']);
    expect(crypto.decrypt(packet.encryptedText, roomKey)).toBe(text);
    await receive(JSON.stringify(packet));
    expect(repository.saveMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text, senderId: 'peer' }));
    expect(onNewMessage).toHaveBeenCalledWith(expect.objectContaining({ text, senderId: 'peer' }));
  });

  it('notifies only once for repeated incoming packets', async () => {
    const payload = packetFrom({ text: 'New file', attachment }, roomKey, crypto);
    await receive(payload);
    await receive(payload);
    expect(repository.saveMessage).toHaveBeenCalledTimes(1);
    expect(onNewMessage).toHaveBeenCalledTimes(1);
  });

  it('waits for persistence and ignores a duplicate while the save is pending', async () => {
    let finishSave!: () => void;
    repository.saveMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const payload = packetFrom({ text: '', attachment }, roomKey, crypto);
    const incoming = receive(payload);
    await receive(payload);
    expect(repository.saveMessage).toHaveBeenCalledTimes(1);
    expect(onNewMessage).not.toHaveBeenCalled();

    finishSave();
    await incoming;
    expect(onNewMessage).toHaveBeenCalledTimes(1);
    expect(onNewMessage).toHaveBeenCalledWith(repository.saveMessage.mock.calls[0][0]);
  });

  it('does not notify after a failed save and allows retrying the incoming packet', async () => {
    repository.saveMessage.mockRejectedValueOnce(new Error('Database busy'));
    const payload = packetFrom({ text: '', attachment }, roomKey, crypto);
    await receive(payload);
    expect(onNewMessage).not.toHaveBeenCalled();

    await receive(payload);
    expect(repository.saveMessage).toHaveBeenCalledTimes(2);
    expect(onNewMessage).toHaveBeenCalledTimes(1);
  });

  it('does not notify when reading saved history', async () => {
    const savedMessage: Message = {
      id: 'saved-peer-message', roomId, text: 'Earlier message', senderId: 'peer', timestamp: 1,
    };
    repository.getMessagesByRoom.mockResolvedValueOnce([savedMessage]);
    await expect(engine.getHistory()).resolves.toEqual([savedMessage]);
    expect(onNewMessage).not.toHaveBeenCalled();
  });

  it('does not reinterpret a legacy JSON message as a file', async () => {
    const text = JSON.stringify({ text: '', attachment });
    await receive(JSON.stringify({
      id: 'legacy-json',
      timestamp: 123,
      encryptedText: crypto.encrypt(text, roomKey),
    }));
    expect(repository.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ text }));
    expect(repository.saveMessage.mock.calls[0][0].attachment).toBeUndefined();
  });

  it.each([
    { ...attachment, size: 6 },
    { ...attachment, base64: 'invalid=' },
    { ...attachment, size: MAX_ATTACHMENT_BYTES + 1 },
    { ...attachment, name: '../file.txt' },
    { ...attachment, mimeType: 'file:///etc/passwd' },
  ])('rejects invalid outbound and inbound attachment %#', async (invalidAttachment) => {
    await expect(engine.sendMessage('', invalidAttachment)).rejects.toThrow();
    await receive(packetFrom({ text: '', attachment: invalidAttachment }, roomKey, crypto));
    expect(network.sendData).not.toHaveBeenCalled();
    expect(repository.saveMessage).not.toHaveBeenCalled();
    expect(onNewMessage).not.toHaveBeenCalled();
  });

  it('allows a zero-byte file and rejects an empty text-only message', async () => {
    await expect(engine.sendMessage('   ')).rejects.toThrow('пустым');
    await engine.sendMessage('', { ...attachment, size: 0, base64: '' });
    expect(repository.saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      attachment: expect.objectContaining({ size: 0, base64: '' }),
    }));
  });

  it('does not save when network transmission fails', async () => {
    network.sendData.mockRejectedValueOnce(new Error('Disconnected'));
    await expect(engine.sendMessage('', attachment)).rejects.toThrow('Disconnected');
    expect(repository.saveMessage).not.toHaveBeenCalled();
  });

  it('ignores an attachment encrypted with another room password', async () => {
    const wrongKey = await crypto.generateRoomKey('another-password');
    await receive(packetFrom({ text: '', attachment }, wrongKey, crypto));
    expect(repository.saveMessage).not.toHaveBeenCalled();
    expect(onNewMessage).not.toHaveBeenCalled();
  });

  it.each([
    'not-json: private-file.txt https://example.com/private',
    JSON.stringify({ id: 'invalid', timestamp: -1, encryptedText: 'encrypted' }),
    JSON.stringify({ id: 'invalid', timestamp: 1, version: 99, encryptedText: 'encrypted' }),
  ])('rejects malformed envelopes without logging content', async (payload) => {
    await receive(payload);
    expect(repository.saveMessage).not.toHaveBeenCalled();
    expect(onNewMessage).not.toHaveBeenCalled();
    expect(appLogger.error).toHaveBeenLastCalledWith(
      'chat', 'Не удалось обработать входящее сообщение', { visibleToUser: true },
    );
    expect(JSON.stringify((appLogger.error as jest.Mock).mock.calls)).not.toContain('private-file');
  });

  it('keeps a pending sent file in the original room after reconnecting', async () => {
    let finishSend!: () => void;
    network.sendData.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSend = resolve; }));
    const sentFile = { ...attachment };
    const send = engine.sendMessage('', sentFile);
    sentFile.name = 'changed.txt';
    engine.disconnect();
    await engine.joinRoom('room-b', 'password-b', jest.fn(), jest.fn());
    finishSend();
    await send;
    expect(repository.saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      roomId, attachment,
    }));
  });

  it('ignores callbacks from a previous room session', async () => {
    const oldReceive = receive;
    engine.disconnect();
    await engine.joinRoom('room-b', 'password-b', jest.fn(), jest.fn());
    await oldReceive(packetFrom({ text: '', attachment }, roomKey, crypto));
    expect(repository.saveMessage).not.toHaveBeenCalled();
    expect(onNewMessage).not.toHaveBeenCalled();
  });

  it('keeps duplicate suppression scoped to the room session', async () => {
    await receive(packetFrom({ text: '', attachment }, roomKey, crypto));
    engine.disconnect();
    const onNextRoomMessage = jest.fn();
    await engine.joinRoom('room-b', 'password-b', onNextRoomMessage, jest.fn());
    const nextRoomKey = await crypto.generateRoomKey('password-b');
    await receive(packetFrom({ text: '', attachment }, nextRoomKey, crypto));
    expect(onNewMessage).toHaveBeenCalledTimes(1);
    expect(onNextRoomMessage).toHaveBeenCalledTimes(1);
  });

  it('does not notify a new screen when an old incoming save finishes', async () => {
    let finishSave!: () => void;
    repository.saveMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const incoming = receive(packetFrom({ text: '', attachment }, roomKey, crypto));
    engine.disconnect();
    finishSave();
    await incoming;
    expect(onNewMessage).not.toHaveBeenCalled();
  });

  it('does not connect after disconnect cancels an in-progress join', async () => {
    engine.disconnect();
    network.connect.mockClear();
    let finishInitialize!: () => void;
    repository.initialize.mockImplementationOnce(() => new Promise<void>((resolve) => { finishInitialize = resolve; }));
    const join = engine.joinRoom('room-c', 'password-c', jest.fn(), jest.fn());
    engine.disconnect();
    finishInitialize();
    await join;
    expect(network.connect).not.toHaveBeenCalled();
    await expect(engine.sendMessage('', attachment)).rejects.toThrow('не вошли');
  });

  it('does not expose stale history after changing rooms', async () => {
    let finishHistory!: (messages: Message[]) => void;
    repository.getMessagesByRoom.mockImplementationOnce(() => new Promise((resolve) => { finishHistory = resolve; }));
    const history = engine.getHistory();
    engine.disconnect();
    finishHistory([{ id: 'old', roomId, text: '', attachment, senderId: 'me', timestamp: 1 }]);
    await expect(history).resolves.toEqual([]);
  });
});
