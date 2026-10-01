export interface MessageTextPart {
  text: string;
  url?: string;
}

function trimLinkEnd(value: string): string {
  let result = value.replace(/[.,!?;:…»]+$/u, '');
  const pairs = [['(', ')'], ['[', ']'], ['{', '}']];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs) {
      if (result.endsWith(close) && result.split(close).length > result.split(open).length) {
        result = result.slice(0, -1).replace(/[.,!?;:…»]+$/u, '');
        changed = true;
      }
    }
  }
  return result;
}

export function splitMessageLinks(text: string): MessageTextPart[] {
  const parts: MessageTextPart[] = [];
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (index > 0 && !/[\s([{<"'«]/u.test(text[index - 1])) continue;
    const label = trimLinkEnd(match[0]);
    const url = /^www\./i.test(label) ? `https://${label}` : label;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) continue;
    } catch {
      continue;
    }
    if (index > offset) parts.push({ text: text.slice(offset, index) });
    parts.push({ text: label, url });
    offset = index + label.length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}
