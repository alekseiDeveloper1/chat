import { splitMessageLinks } from '@/shared/links/messageLinks';

describe('message links', () => {
  it('preserves text while exposing multiple clickable links', () => {
    const text = 'Смотри https://example.com/a?q=1&b=2 и www.example.org.';
    const parts = splitMessageLinks(text);
    expect(parts.map(part => part.text).join('')).toBe(text);
    expect(parts.filter(part => part.url)).toEqual([
      { text: 'https://example.com/a?q=1&b=2', url: 'https://example.com/a?q=1&b=2' },
      { text: 'www.example.org', url: 'https://www.example.org' },
    ]);
  });

  it.each([
    ['(https://example.com/file).', 'https://example.com/file'],
    ['https://example.com/Function_(math)', 'https://example.com/Function_(math)'],
    ['«https://example.com/путь!»', 'https://example.com/путь'],
    ['HTTP://example.com', 'HTTP://example.com'],
    ['[https://example.com/test],', 'https://example.com/test'],
  ])('recognizes links and separates punctuation: %s', (text, expected) => {
    const parts = splitMessageLinks(text);
    expect(parts.map(part => part.text).join('')).toBe(text);
    expect(parts.find(part => part.url)?.url).toBe(expected);
  });

  it.each(['javascript:alert(1)', 'file:///tmp/a', 'data:text/html,hi', 'ftp://www.example.com', 'a@www.example.com', 'https://', 'обычный текст'])('leaves non-web links/plain text unchanged: %s', text => {
    expect(splitMessageLinks(text)).toEqual([{ text }]);
  });

  it('handles empty messages used with file-only attachments', () => {
    expect(splitMessageLinks('')).toEqual([]);
  });
});
