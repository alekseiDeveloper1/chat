import { IStrictDataChannel } from './webrtcTypes';

const FRAME_PREFIX = '!chat-chunk-v1!';
export const MAX_TRANSPORT_PAYLOAD_LENGTH = 12 * 1024 * 1024;
export const MAX_DATA_CHANNEL_FRAME_BYTES = 16 * 1024;
export const TRANSFER_IDLE_TIMEOUT_MS = 30_000;
export const MAX_BUFFERED_AMOUNT = 256 * 1024;
const MAX_PENDING_TRANSFERS = 2;
const CHUNK_LENGTH = 12 * 1024;
const SEND_POLL_INTERVAL_MS = 25;
const SEND_BURST_FRAMES = 8;
const MAX_INCOMING_CHUNKS = MAX_TRANSPORT_PAYLOAD_LENGTH / 1024;

type Chunk = { id: string; offset: number; total: number; data: string };
type IncomingTransfer = {
  total: number;
  received: number;
  chunks: string[];
  timeout: ReturnType<typeof setTimeout>;
};

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

export class DataChannelTransport {
  private readonly incoming = new Map<string, IncomingTransfer>();
  private incomingLength = 0;
  private readonly cancelWaits = new Set<() => void>();
  private sendQueue: Promise<void> = Promise.resolve();
  private pendingSends = 0;
  private nextTransferId = 0;
  private disposed = false;

  constructor(
    private readonly channel: IStrictDataChannel,
    private readonly isCurrent: () => boolean,
  ) {}

  async send(payload: string): Promise<void> {
    this.assertOpen();
    if (payload.length > MAX_TRANSPORT_PAYLOAD_LENGTH) {
      throw new Error('Сообщение превышает допустимый размер передачи');
    }
    if (this.pendingSends >= MAX_PENDING_TRANSFERS) {
      throw new Error('Дождитесь завершения предыдущей отправки');
    }

    this.pendingSends += 1;
    const task = this.sendQueue.then(() => this.sendPayload(payload));
    this.sendQueue = task.catch(() => {});
    try {
      await task;
    } finally {
      this.pendingSends -= 1;
    }
  }

  receive(payload: unknown): string | null {
    if (this.disposed || !this.isCurrent()) return null;
    if (typeof payload !== 'string' || payload.length > MAX_TRANSPORT_PAYLOAD_LENGTH) {
      throw new Error('Некорректный размер или формат сообщения');
    }
    if (!payload.startsWith(FRAME_PREFIX)) return payload;
    if (payload.length > MAX_DATA_CHANNEL_FRAME_BYTES || utf8ByteLength(payload) > MAX_DATA_CHANNEL_FRAME_BYTES) {
      throw new Error('Превышен размер фрагмента сообщения');
    }

    let frame: unknown;
    try {
      frame = JSON.parse(payload.slice(FRAME_PREFIX.length));
    } catch {
      throw new Error('Некорректный фрагмент сообщения');
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      throw new Error('Некорректный фрагмент сообщения');
    }
    const chunk = frame as Partial<Chunk>;
    const id = typeof chunk.id === 'string' && /^[a-z0-9-]{1,64}$/.test(chunk.id) ? chunk.id : null;
    if (!id || !Number.isSafeInteger(chunk.total) || chunk.total! <= 0 ||
      chunk.total! > MAX_TRANSPORT_PAYLOAD_LENGTH || !Number.isSafeInteger(chunk.offset) ||
      chunk.offset! < 0 || chunk.offset! >= chunk.total! || typeof chunk.data !== 'string' ||
      chunk.data.length === 0 || chunk.data.length > chunk.total! - chunk.offset!) {
      if (id) this.removeIncoming(id);
      throw new Error('Некорректный фрагмент сообщения');
    }

    const { total, offset, data } = chunk as Chunk;
    let transfer = this.incoming.get(id);
    if (!transfer && offset === 0) {
      if (this.incoming.size >= MAX_PENDING_TRANSFERS ||
        this.incomingLength + total > MAX_TRANSPORT_PAYLOAD_LENGTH * MAX_PENDING_TRANSFERS) {
        throw new Error('Слишком много незавершённых передач');
      }
      transfer = {
        total,
        received: 0,
        chunks: [],
        timeout: setTimeout(() => this.removeIncoming(id), TRANSFER_IDLE_TIMEOUT_MS),
      };
      this.incoming.set(id, transfer);
      this.incomingLength += total;
    }
    if (!transfer || transfer.total !== total || transfer.received !== offset ||
      transfer.chunks.length >= MAX_INCOMING_CHUNKS) {
      this.removeIncoming(id);
      throw new Error('Нарушен порядок фрагментов сообщения');
    }

    transfer.chunks.push(data);
    transfer.received += data.length;
    clearTimeout(transfer.timeout);
    if (transfer.received === total) {
      this.removeIncoming(id);
      return transfer.chunks.join('');
    }
    transfer.timeout = setTimeout(() => this.removeIncoming(id), TRANSFER_IDLE_TIMEOUT_MS);
    return null;
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.incoming.keys()) this.removeIncoming(id);
    for (const cancel of this.cancelWaits) cancel();
    this.cancelWaits.clear();
  }

  private async sendPayload(payload: string): Promise<void> {
    this.assertOpen();
    if (!payload.startsWith(FRAME_PREFIX) && utf8ByteLength(payload) <= MAX_DATA_CHANNEL_FRAME_BYTES) {
      await this.waitForCapacity();
      this.assertOpen();
      this.channel.send(payload);
      this.assertOpen();
      return;
    }

    const id = `${Date.now().toString(36)}-${(this.nextTransferId++).toString(36)}`;
    let offset = 0;
    let sentFrames = 0;
    while (offset < payload.length) {
      let size = Math.min(CHUNK_LENGTH, payload.length - offset);
      let frame: string;
      do {
        frame = FRAME_PREFIX + JSON.stringify({ id, offset, total: payload.length, data: payload.slice(offset, offset + size) });
        if (utf8ByteLength(frame) <= MAX_DATA_CHANNEL_FRAME_BYTES) break;
        size = Math.floor(size / 2);
      } while (size > 0);

      await this.waitForCapacity();
      this.assertOpen();
      this.channel.send(frame);
      offset += size;
      sentFrames += 1;
      if (sentFrames % SEND_BURST_FRAMES === 0) await this.wait(0);
    }
    await this.wait(0);
    await this.waitForCapacity();
    this.assertOpen();
  }

  private async waitForCapacity(): Promise<void> {
    const deadline = Date.now() + TRANSFER_IDLE_TIMEOUT_MS;
    this.assertOpen();
    while (this.channel.bufferedAmount > MAX_BUFFERED_AMOUNT - MAX_DATA_CHANNEL_FRAME_BYTES) {
      if (Date.now() >= deadline) throw new Error('Истекло время ожидания отправки сообщения');
      await this.wait(SEND_POLL_INTERVAL_MS);
      this.assertOpen();
    }
  }

  private wait(delayMs: number): Promise<void> {
    this.assertOpen();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        this.cancelWaits.delete(cancel);
        reject(new Error('P2P соединение прервано во время отправки'));
      };
      const timer = setTimeout(() => {
        this.cancelWaits.delete(cancel);
        resolve();
      }, delayMs);
      this.cancelWaits.add(cancel);
    });
  }

  private assertOpen(): void {
    if (this.disposed || !this.isCurrent() || this.channel.readyState !== 'open') {
      throw new Error('Нет активного P2P соединения');
    }
  }

  private removeIncoming(id: string): void {
    const transfer = this.incoming.get(id);
    if (!transfer) return;
    clearTimeout(transfer.timeout);
    this.incomingLength -= transfer.total;
    this.incoming.delete(id);
  }
}
