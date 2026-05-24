import { AESCryptoService } from '@/data/crypto/AESCryptoService';
import { ICryptoService } from '@/domain/services/ICryptoService';

describe('AESCryptoService (TDD Сквозное шифрование)', () => {
  let cryptoService: ICryptoService;
  const PASSWORD = 'super-secret-room-password-123';
  const RAW_MESSAGE = 'Привет! Это приватное P2P сообщение.';

  beforeEach(() => {
    cryptoService = new AESCryptoService();
  });

  it('должен успешно зашифровать и расшифровать сообщение правильным ключом', async () => {
    const roomKey = await cryptoService.generateRoomKey(PASSWORD);
    expect(roomKey).toBeDefined();
    expect(typeof roomKey).toBe('string');

    const encrypted = cryptoService.encrypt(RAW_MESSAGE, roomKey);
    expect(encrypted).not.toBe(RAW_MESSAGE);
    expect(encrypted.length).toBeGreaterThan(0);

    const decrypted = cryptoService.decrypt(encrypted, roomKey);
    expect(decrypted).toBe(RAW_MESSAGE);
  });

  it('не должен расшифровать сообщение, если передан неверный ключ', async () => {
    const correctKey = await cryptoService.generateRoomKey(PASSWORD);
    const wrongKey = await cryptoService.generateRoomKey('wrong-password');
    const encrypted = cryptoService.encrypt(RAW_MESSAGE, correctKey);
    const decryptedWithWrongKey = cryptoService.decrypt(encrypted, wrongKey);
    expect(decryptedWithWrongKey).toBeNull();
  });
});
