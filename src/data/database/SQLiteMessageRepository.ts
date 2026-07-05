import * as SQLite from 'expo-sqlite';
import { IMessageRepository } from '@/domain/services/IMessageRepository';
import { Message } from '@/domain/entities/Message';

export class SQLiteMessageRepository implements IMessageRepository {
  private db: any = null;

  async getDbInstance() {
    if (!this.db) {
      this.db = await SQLite.openDatabaseAsync('p2p_chat_local.db');
    }
    return this.db;
  }

  async initialize(): Promise<void> {
    const db = await this.getDbInstance();

    await db.execAsync(`PRAGMA journal_mode = WAL;`);

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        room_id TEXT NOT NULL,
        text TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
    `);
  }

  async saveMessage(message: Message): Promise<void> {
    const db = await this.getDbInstance();

    await db.runAsync(
      `INSERT OR REPLACE INTO messages (id, room_id, text, sender_id, timestamp)
       VALUES (?, ?, ?, ?, ?);`,
      [
        message.id,
        message.roomId,
        message.text,
        message.senderId,
        message.timestamp,
      ]
    );
  }

  async getMessagesByRoom(roomId: string): Promise<Message[]> {
    const db = await this.getDbInstance();

    const rows: any[] = await db.getAllAsync(
      `SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC;`,
      [roomId]
    );

    return rows.map(row => ({
      id: row.id,
      roomId: row.room_id,
      text: row.text,
      senderId: row.sender_id,
      timestamp: row.timestamp,
    }));
  }

  async clearRoomHistory(roomId: string): Promise<void> {
    const db = await this.getDbInstance();
    await db.runAsync(`DELETE FROM messages WHERE room_id = ?;`, [roomId]);
  }
}
