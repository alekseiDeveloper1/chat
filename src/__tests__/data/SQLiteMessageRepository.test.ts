import * as SQLite from 'expo-sqlite';
import { SQLiteMessageRepository } from '@/data/database/SQLiteMessageRepository';
import { Message } from '@/domain/entities/Message';

describe('SQLiteMessageRepository', () => {
  let repository: SQLiteMessageRepository;
  let db: SQLite.SQLiteDatabase;
  let getAll: jest.Mock;
  let exec: jest.Mock;
  let run: jest.Mock;

  const textMessage: Message = {
    id: 'msg-123',
    roomId: 'room-hash-abc',
    text: 'Сохранённая ссылка https://example.com/report',
    senderId: 'user-1',
    timestamp: 1700000000000,
  };
  const fileMessage: Message = {
    ...textMessage,
    id: 'msg-file',
    text: '',
    attachment: { name: 'report.txt', mimeType: 'text/plain', size: 5, base64: 'SGVsbG8=' },
  };

  beforeEach(async () => {
    repository = new SQLiteMessageRepository();
    db = await repository.getDbInstance();
    getAll = db.getAllAsync as jest.Mock;
    exec = db.execAsync as jest.Mock;
    run = db.runAsync as jest.Mock;
    getAll.mockReset().mockResolvedValue([{ name: 'attachment' }]);
    exec.mockReset().mockResolvedValue(undefined);
    run.mockReset().mockResolvedValue({ changes: 1 });
  });

  it('adds a nullable attachment column to an existing text-only database', async () => {
    getAll.mockResolvedValueOnce([
      { name: 'id' }, { name: 'room_id' }, { name: 'text' }, { name: 'sender_id' }, { name: 'timestamp' },
    ]);
    await repository.initialize();
    expect(exec).toHaveBeenCalledWith('ALTER TABLE messages ADD COLUMN attachment TEXT;');
    expect(exec.mock.calls.flat().join(' ')).not.toMatch(/DROP|DELETE/i);
  });

  it('does not repeat a completed migration after opening another repository', async () => {
    await repository.initialize();
    const reopened = new SQLiteMessageRepository();
    await reopened.initialize();
    expect(exec).not.toHaveBeenCalledWith(expect.stringContaining('ALTER TABLE'));
  });

  it('shares initialization between concurrent callers', async () => {
    await Promise.all([repository.initialize(), repository.initialize(), repository.saveMessage(textMessage)]);
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it('retries initialization after a migration error', async () => {
    getAll.mockResolvedValue([{ name: 'text' }]);
    exec.mockImplementationOnce(() => Promise.reject(new Error('Database busy')));
    await expect(repository.initialize()).rejects.toThrow('Database busy');
    await expect(repository.initialize()).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledWith('ALTER TABLE messages ADD COLUMN attachment TEXT;');
  });

  it('stores text and links with a null attachment', async () => {
    await repository.saveMessage(textMessage);
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('INTO messages'),
      [textMessage.id, textMessage.roomId, textMessage.text, textMessage.senderId, textMessage.timestamp, null],
    );
  });

  it('stores the entire file with bound parameters and restores it in history', async () => {
    await repository.saveMessage(fileMessage);
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('VALUES (?, ?, ?, ?, ?, ?)'),
      [fileMessage.id, fileMessage.roomId, '', fileMessage.senderId, fileMessage.timestamp, JSON.stringify(fileMessage.attachment)],
    );

    const saved = run.mock.calls[0][1];
    getAll.mockResolvedValueOnce([{
      id: saved[0], room_id: saved[1], text: saved[2], sender_id: saved[3], timestamp: saved[4], attachment: saved[5],
    }]);
    await expect(repository.getMessagesByRoom(fileMessage.roomId)).resolves.toEqual([fileMessage]);
    expect(getAll).toHaveBeenLastCalledWith(expect.stringContaining('ORDER BY timestamp ASC'), [fileMessage.roomId]);
  });

  it('restores old text-only rows without changing their contents', async () => {
    await repository.initialize();
    getAll.mockResolvedValueOnce([{
      id: textMessage.id, room_id: textMessage.roomId, text: textMessage.text,
      sender_id: textMessage.senderId, timestamp: textMessage.timestamp, attachment: null,
    }]);
    await expect(repository.getMessagesByRoom(textMessage.roomId)).resolves.toEqual([textMessage]);
  });

  it('rejects an invalid attachment before writing it', async () => {
    await expect(repository.saveMessage({
      ...fileMessage,
      attachment: { ...fileMessage.attachment!, size: 100 },
    })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('clears both files and texts only in the requested room', async () => {
    await repository.clearRoomHistory('room-hash-abc');
    expect(run).toHaveBeenCalledWith('DELETE FROM messages WHERE room_id = ?;', ['room-hash-abc']);
  });
});
