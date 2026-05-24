import * as Crypto from 'expo-crypto';
import CryptoJS from 'crypto-js';
import { ICryptoService } from '@/domain/services/ICryptoService';

export class AESCryptoService implements ICryptoService {

  async generateRoomKey(password: string): Promise<string> {
    if (!password || password.trim() === '') {
      throw new Error('Пароль комнаты не может быть пустым');
    }

    return await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      password
    );
  }

  encrypt(text: string, roomKey: string): string {
    return CryptoJS.AES.encrypt(text, roomKey).toString();
  }

  decrypt(cipherText: string, roomKey: string): string | null {
    try {
      const bytes = CryptoJS.AES.decrypt(cipherText, roomKey);
      const decryptedText = bytes.toString(CryptoJS.enc.Utf8);

      if (!decryptedText) {
        return null;
      }

      return decryptedText;
    } catch (error) {
      return null;
    }
  }
}
