import * as SQLite from 'expo-sqlite';
import { IMessageRepository } from '@/domain/services/IMessageRepository';
import { FileAttachment, Message, validateFileAttachment } from '@/domain/entities/Message';

interface MessageRow {
  id: string;
  room_id: string;
  text: string;
  sender_id: string;
  timestamp: number;
  attachment: string | null;
}

export class SQLiteMessageRepository implements IMessageRepository {
  private dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
  private initialization: Promise<void> | null = null;

  getDbInstance(): Promise<SQLite.SQLiteDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = SQLite.openDatabaseAsync('p2p_chat_local.db').catch((error) => {
        this.dbPromise = null;
        throw error;
      });
    }
    return this.dbPromise;
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeSchema().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  private async initializeSchema(): Promise<void> {
    const db = await this.getDbInstance();
    await db.execAsync('PRAGMA journal_mode = WAL;');
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        room_id TEXT NOT NULL,
        text TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        attachment TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
    `);

    // Existing installations keep their text history; new nullable data is additive.
    const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(messages);');
    if (!columns.some((column) => column.name === 'attachment')) {
      await db.execAsync('ALTER TABLE messages ADD COLUMN attachment TEXT;');
    }
  }

  async saveMessage(message: Message): Promise<void> {
    if (message.attachment) validateFileAttachment(message.attachment);
    await this.initialize();
    const db = await this.getDbInstance();
    await db.runAsync(
      `INSERT OR REPLACE INTO messages (id, room_id, text, sender_id, timestamp, attachment)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [
        message.id,
        message.roomId,
        message.text,
        message.senderId,
        message.timestamp,
        message.attachment ? JSON.stringify(message.attachment) : null,
      ]
    );
  }

  async getMessagesByRoom(roomId: string): Promise<Message[]> {
    await this.initialize();
    const db = await this.getDbInstance();
    const rows = await db.getAllAsync<MessageRow>(
      'SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC;',
      [roomId]
    );

    return rows.map((row) => {
      let attachment: FileAttachment | undefined;
      if (row.attachment) {
        const stored: unknown = JSON.parse(row.attachment);
        validateFileAttachment(stored);
        attachment = stored;
      }
      return {
        id: row.id,
        roomId: row.room_id,
        text: row.text,
        senderId: row.sender_id,
        timestamp: row.timestamp,
        ...(attachment ? { attachment } : {}),
      };
    });
  }

  async clearRoomHistory(roomId: string): Promise<void> {
    await this.initialize();
    const db = await this.getDbInstance();
    await db.runAsync('DELETE FROM messages WHERE room_id = ?;', [roomId]);
  }
}
