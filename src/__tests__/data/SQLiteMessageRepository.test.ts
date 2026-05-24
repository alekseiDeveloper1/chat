import { SQLiteMessageRepository } from '@/data/database/SQLiteMessageRepository';
import { Message } from '@/domain/entities/Message';

describe('SQLiteMessageRepository (Интеграция с БД)', () => {
  let repository: SQLiteMessageRepository;

  const mockMessage: Message = {
    id: 'msg-123',
    roomId: 'room-hash-abc',
    text: 'U2FsdGVkX19...',
    senderId: 'user-1',
    timestamp: 1700000000000,
  };

  beforeEach(() => {
    repository = new SQLiteMessageRepository();
  });

  it('должен вызывать инициализацию таблиц без ошибок', async () => {
    await expect(repository.initialize()).resolves.not.toThrow();
  });

  it('должен отправлять правильный SQL-запрос при сохранении сообщения', async () => {
    const dbMock = await repository.getDbInstance();

    await repository.saveMessage(mockMessage);

    expect(dbMock.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INTO messages'),
      [
        mockMessage.id,
        mockMessage.roomId,
        mockMessage.text,
        mockMessage.senderId,
        mockMessage.timestamp,
      ]
    );
  });
});
