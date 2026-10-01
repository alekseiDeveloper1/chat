import {
  DataChannelTransport,
  MAX_BUFFERED_AMOUNT,
  MAX_DATA_CHANNEL_FRAME_BYTES,
  MAX_TRANSPORT_PAYLOAD_LENGTH,
  TRANSFER_IDLE_TIMEOUT_MS,
} from '@/data/network/DataChannelTransport';

const frame = (id: string, offset: number, total: number, data: string) =>
  '!chat-chunk-v1!' + JSON.stringify({ id, offset, total, data });

function createTransport() {
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    send: jest.fn(),
    close: jest.fn(),
    addEventListener: jest.fn(),
  };
  let current = true;
  const transport = new DataChannelTransport(channel, () => current);
  return { channel, transport, replaceConnection: () => { current = false; } };
}

const flushMicrotasks = async () => {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
};

describe('DataChannelTransport', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('preserves the existing wire format for short encrypted text', async () => {
    const { channel, transport } = createTransport();
    await transport.send('encrypted-text');
    expect(channel.send).toHaveBeenCalledWith('encrypted-text');
    expect(transport.receive('encrypted-text')).toBe('encrypted-text');
  });

  it('reassembles a 10 MiB encrypted attachment and only delivers the complete payload', async () => {
    jest.useRealTimers();
    const sender = createTransport();
    const receiver = createTransport();
    const received: string[] = [];
    const payload = 'a'.repeat(10 * 1024 * 1024);
    sender.channel.send.mockImplementation((wire: string) => {
      expect(Buffer.byteLength(wire, 'utf8')).toBeLessThanOrEqual(MAX_DATA_CHANNEL_FRAME_BYTES);
      const result = receiver.transport.receive(wire);
      if (result !== null) received.push(result);
    });
    await sender.transport.send(payload);
    expect(sender.channel.send.mock.calls.length).toBeGreaterThan(100);
    expect(received).toEqual([payload]);
  });

  it('roundtrips Unicode, JSON escapes and content resembling a transport frame', async () => {
    jest.useRealTimers();
    const sender = createTransport();
    const receiver = createTransport();
    const payload = '!chat-chunk-v1!' + '😀\n\u0000\\"Привет'.repeat(5000);
    let result: string | null = null;
    sender.channel.send.mockImplementation((wire: string) => {
      expect(Buffer.byteLength(wire, 'utf8')).toBeLessThanOrEqual(MAX_DATA_CHANNEL_FRAME_BYTES);
      result = receiver.transport.receive(wire);
    });
    await sender.transport.send(payload);
    expect(result).toBe(payload);
  });

  it('discards unfinished transfers after inactivity and releases their capacity', () => {
    const { transport } = createTransport();
    expect(transport.receive(frame('a', 0, 2, 'x'))).toBeNull();
    expect(transport.receive(frame('b', 0, 2, 'x'))).toBeNull();
    expect(() => transport.receive(frame('c', 0, 2, 'x'))).toThrow('Слишком много');
    jest.advanceTimersByTime(TRANSFER_IDLE_TIMEOUT_MS);
    expect(() => transport.receive(frame('a', 1, 2, 'y'))).toThrow('порядок');
    expect(transport.receive(frame('c', 0, 2, 'x'))).toBeNull();
    transport.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    '!chat-chunk-v1!{',
    '!chat-chunk-v1!null',
    '!chat-chunk-v1![]',
    frame('a', 0, MAX_TRANSPORT_PAYLOAD_LENGTH + 1, 'x'),
    frame('a', -1, 2, 'x'),
    frame('a', 0.5, 2, 'x'),
    frame('a', 0, 1, 'xx'),
    frame('a', 0, 2, ''),
    frame('__invalid id__', 0, 2, 'x'),
    frame('a', 0, 32_000, 'x'.repeat(MAX_DATA_CHANNEL_FRAME_BYTES)),
  ])('rejects invalid framing without delivering data (%#)', (wire) => {
    const { transport } = createTransport();
    expect(() => transport.receive(wire)).toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects binary payloads and oversized legacy messages', () => {
    const { transport } = createTransport();
    expect(() => transport.receive(new ArrayBuffer(4))).toThrow();
    expect(() => transport.receive('x'.repeat(MAX_TRANSPORT_PAYLOAD_LENGTH + 1))).toThrow();
  });

  it.each([
    frame('a', 0, 3, 'x'),
    frame('a', 2, 3, 'z'),
    frame('a', 1, 4, 'y'),
  ])('discards a transfer with duplicate, missing or inconsistent chunks (%#)', (wire) => {
    const { transport } = createTransport();
    expect(transport.receive(frame('a', 0, 3, 'x'))).toBeNull();
    expect(() => transport.receive(wire)).toThrow();
    expect(() => transport.receive(frame('a', 1, 3, 'yz'))).toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds the number of tiny chunks, as well as their total length', () => {
    const { transport } = createTransport();
    for (let offset = 0; offset < MAX_TRANSPORT_PAYLOAD_LENGTH / 1024; offset += 1) {
      transport.receive(frame('a', offset, MAX_TRANSPORT_PAYLOAD_LENGTH, 'x'));
    }
    expect(() => transport.receive(frame('a', MAX_TRANSPORT_PAYLOAD_LENGTH / 1024,
      MAX_TRANSPORT_PAYLOAD_LENGTH, 'x'))).toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits for the native send buffer to drain', async () => {
    const { channel, transport } = createTransport();
    channel.bufferedAmount = MAX_BUFFERED_AMOUNT;
    const sending = transport.send('message');
    await flushMicrotasks();
    expect(channel.send).not.toHaveBeenCalled();
    channel.bufferedAmount = 0;
    jest.advanceTimersByTime(25);
    await sending;
    expect(channel.send).toHaveBeenCalledWith('message');
  });

  it('times out when the native send buffer never drains', async () => {
    const { channel, transport } = createTransport();
    channel.bufferedAmount = MAX_BUFFERED_AMOUNT;
    const rejected = expect(transport.send('message')).rejects.toThrow('Истекло время');
    await flushMicrotasks();
    jest.advanceTimersByTime(TRANSFER_IDLE_TIMEOUT_MS);
    await rejected;
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('yields between bounded bursts to observe native backpressure', async () => {
    const { channel, transport } = createTransport();
    channel.send.mockImplementation(() => {
      if (channel.send.mock.calls.length === 8) channel.bufferedAmount = MAX_BUFFERED_AMOUNT;
    });
    const sending = transport.send('a'.repeat(200_000));
    await flushMicrotasks();
    jest.advanceTimersByTime(100);
    await flushMicrotasks();
    expect(channel.send).toHaveBeenCalledTimes(8);
    channel.bufferedAmount = 0;
    for (let index = 0; index < 5; index += 1) {
      jest.runOnlyPendingTimers();
      await flushMicrotasks();
    }
    await sending;
    expect(channel.send.mock.calls.length).toBeGreaterThan(8);
  });

  it('cancels stalled sends immediately and clears incoming data on disposal', async () => {
    const { channel, transport } = createTransport();
    transport.receive(frame('a', 0, 2, 'x'));
    channel.bufferedAmount = MAX_BUFFERED_AMOUNT;
    const rejected = expect(transport.send('message')).rejects.toThrow('прервано');
    await flushMicrotasks();
    transport.dispose();
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
    expect(transport.receive(frame('a', 1, 2, 'y'))).toBeNull();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('rejects queued sends when the connection changes during a transfer', async () => {
    const { channel, transport, replaceConnection } = createTransport();
    channel.send.mockImplementationOnce(replaceConnection);
    const first = expect(transport.send('a'.repeat(100_000))).rejects.toThrow('Нет активного');
    const second = expect(transport.send('queued')).rejects.toThrow('Нет активного');
    await first;
    await second;
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('rejects a closed channel, excessive payloads and excessive queued sends', async () => {
    const { channel, transport } = createTransport();
    channel.readyState = 'connecting';
    await expect(transport.send('a')).rejects.toThrow('Нет активного');
    channel.readyState = 'open';
    await expect(transport.send('a'.repeat(MAX_TRANSPORT_PAYLOAD_LENGTH + 1))).rejects.toThrow('размер');
    channel.bufferedAmount = MAX_BUFFERED_AMOUNT;
    const first = transport.send('first').catch(() => {});
    const second = transport.send('second').catch(() => {});
    await expect(transport.send('third')).rejects.toThrow('Дождитесь');
    transport.dispose();
    await Promise.all([first, second]);
  });

  it('propagates native send failures and permits a subsequent send', async () => {
    const { channel, transport } = createTransport();
    channel.send.mockImplementationOnce(() => { throw new Error('native send failed'); });
    await expect(transport.send('a')).rejects.toThrow('native send failed');
    await transport.send('b');
    expect(channel.send).toHaveBeenLastCalledWith('b');
  });
});
