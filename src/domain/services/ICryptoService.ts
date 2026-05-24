export interface ICryptoService {
  generateRoomKey(password: string): Promise<string>;

  encrypt(text: string, roomKey: string): string;

  decrypt(cipherText: string, roomKey: string): string | null;
}
