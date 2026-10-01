import { MAX_ATTACHMENT_BYTES, validateFileAttachment } from '@/domain/entities/Message';

const validFile = { name: 'hello.txt', mimeType: 'text/plain', size: 5, base64: 'SGVsbG8=' };

describe('FileAttachment validation', () => {
  it('accepts a file exactly at the size limit', () => {
    const base64 = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString('base64');
    expect(() => validateFileAttachment({ ...validFile, size: MAX_ATTACHMENT_BYTES, base64 })).not.toThrow();
  });

  it.each([
    null,
    {},
    { ...validFile, name: '.' },
    { ...validFile, name: '..' },
    { ...validFile, name: 'dir/file.txt' },
    { ...validFile, name: 'dir\\file.txt' },
    { ...validFile, name: 'file\u0000.txt' },
    { ...validFile, name: 'x'.repeat(256) },
    { ...validFile, size: -1 },
    { ...validFile, size: 0.5 },
    { ...validFile, size: Number.NaN },
    { ...validFile, size: MAX_ATTACHMENT_BYTES + 1 },
    { ...validFile, base64: 'SGVsbG8' },
    { ...validFile, base64: 'SGVsbG9=' },
    { ...validFile, base64: 'A===', size: 1 },
    { ...validFile, base64: 'data:text/plain;base64,SGVsbG8=' },
    { ...validFile, base64: 'SGVs bG8=' },
    { ...validFile, base64: '', size: 5 },
  ])('rejects malformed or unsafe file %#', (value) => {
    expect(() => validateFileAttachment(value)).toThrow();
  });
});
