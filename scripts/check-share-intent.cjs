// Run the installed (patch-package corrected) parser without a React Native runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const parserPath = path.join(path.dirname(require.resolve('expo-share-intent/package.json')), 'build/utils.js');
const source = ts.transpileModule(fs.readFileSync(parserPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleExports = {};
const defaultValue = { files: null, text: null, webUrl: null, type: null };
vm.runInNewContext(source, {
  exports: moduleExports,
  console: { debug() {} },
  require(name) {
    if (name === 'expo-constants') return { default: { expoConfig: { scheme: 'chat' } } };
    if (name === 'expo-linking') return { createURL: (value) => `chat://${value}` };
    if (name === './useShareIntent') return { SHAREINTENT_DEFAULTVALUE: defaultValue };
    throw new Error(`Unexpected parser dependency: ${name}`);
  },
}, { filename: parserPath });

// Normalize objects from the VM realm before asserting their public values.
const parse = (payload) => JSON.parse(JSON.stringify(moduleExports.parseShareIntent(payload, { debug: false })));

test('plain text remains text with its title', () => {
  const result = parse({ text: 'A shared note', meta: { title: 'Note' } });
  assert.equal(result.type, 'text');
  assert.equal(result.text, 'A shared note');
  assert.equal(result.files, null);
  assert.equal(result.meta.title, 'Note');
});

test('a URL within Android shared text remains available', () => {
  const result = parse({ text: 'Read https://example.com/article?a=1' });
  assert.equal(result.type, 'weburl');
  assert.equal(result.webUrl, 'https://example.com/article?a=1');
  assert.equal(result.text, 'Read https://example.com/article?a=1');
});

test('iOS JSON web URLs preserve page metadata', () => {
  const result = parse(JSON.stringify({ weburls: [{ url: 'https://example.com/', meta: '{"title":"Article"}' }] }));
  assert.equal(result.type, 'weburl');
  assert.equal(result.webUrl, 'https://example.com/');
  assert.equal(result.meta.title, 'Article');
});

test('a text/plain file is an attachment even when it has a caption', () => {
  const result = parse({
    text: 'Please read',
    files: [{ filePath: '/cache/note.txt', fileName: 'note.txt', mimeType: 'text/plain', fileSize: 12 }],
  });
  assert.equal(result.type, 'file');
  assert.equal(result.text, 'Please read');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'file:///cache/note.txt');
  assert.equal(result.files[0].mimeType, 'text/plain');
  assert.equal(result.files[0].size, 12);
});

test('multiple attachments retain caption, URL, and their individual MIME types', () => {
  const result = parse({
    text: 'Two files',
    weburls: [{ url: 'https://example.com/' }],
    files: [
      { filePath: '/cache/photo.jpg', mimeType: 'image/jpeg' },
      { filePath: '/cache/readme.txt', mimeType: 'text/plain' },
    ],
  });
  assert.equal(result.type, 'file');
  assert.equal(result.text, 'Two files');
  assert.equal(result.webUrl, 'https://example.com/');
  assert.deepEqual(result.files.map((file) => file.mimeType), ['image/jpeg', 'text/plain']);
});

test('only a set entirely composed of images or videos is classified as media', () => {
  const result = parse({ files: [
    { path: 'file:///cache/image.png', mimeType: 'image/png' },
    { path: 'file:///cache/video.mp4', mimeType: 'video/mp4' },
  ] });
  assert.equal(result.type, 'media');
  assert.equal(result.files.length, 2);
});

test('missing and null MIME types preserve files without crashing', () => {
  const result = parse({ files: [
    { filePath: '/cache/unknown' },
    { filePath: '/cache/another', mimeType: null },
    { filePath: '/cache/last', mimeType: 123 },
  ] });
  assert.equal(result.type, 'file');
  assert.deepEqual(result.files.map((file) => file.mimeType), [null, null, null]);
});

test('malformed entries are ignored while valid files survive', () => {
  const result = parse({ files: [null, false, 123, 'invalid', {}, { path: 123 }, { filePath: '/cache/valid' }] });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'file:///cache/valid');
});

test('invalid payloads do not produce a fake attachment', () => {
  for (const payload of [null, undefined, false, 5, '{', 'null', { files: 'invalid' }, { files: [null, {}] }]) {
    const result = parse(payload);
    assert.equal(result.files, null);
    assert.equal(result.type, null);
  }
});

test('raw Android paths encode spaces and literal percent sequences exactly once', () => {
  const rawPath = '/cache/report #50% literal%20name.txt';
  const result = parse({ files: [{ filePath: rawPath }] });
  assert.equal(result.files[0].path, 'file:///cache/report%20%2350%25%20literal%2520name.txt');
  assert.equal(decodeURIComponent(new URL(result.files[0].path).pathname), rawPath);
});

test('already encoded file URIs and original Android content URIs remain unchanged', () => {
  const paths = ['file:///cache/a%20b%25.txt', 'content://documents/tree/primary%3ADownload/document/primary%3Aa%20b.txt'];
  const result = parse({ files: [{ path: paths[0] }, { contentUri: paths[1] }] });
  assert.deepEqual(result.files.map((file) => file.path), paths);
});

test('numeric metadata accepts zero and valid numeric strings while rejecting invalid values', () => {
  const result = parse({ files: [{
    filePath: '/cache/empty.txt', fileSize: '0', width: null, height: -1, duration: 'not-a-number',
  }] });
  assert.equal(result.files[0].size, 0);
  assert.equal(result.files[0].width, null);
  assert.equal(result.files[0].height, null);
  assert.equal(result.files[0].duration, null);
});
