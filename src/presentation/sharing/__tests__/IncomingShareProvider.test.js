import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { useShareIntent } from 'expo-share-intent';
import { importSharedContent } from '@/data/sharing/IncomingShare';
import { appLogger } from '@/shared/logging/AppLogger';
import { IncomingShareProvider, useIncomingShares } from '../IncomingShareProvider';
import { redirectSystemPath } from '@/app/+native-intent';

jest.mock('expo-share-intent', () => ({ useShareIntent: jest.fn() }));
jest.mock('@/data/sharing/IncomingShare', () => ({ importSharedContent: jest.fn() }));

const payload = (text) => ({ text, webUrl: null, files: null, type: 'text' });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe('IncomingShareProvider', () => {
  let screen;
  let incoming;
  let native;

  function Consumer() {
    incoming = useIncomingShares();
    return null;
  }
  const tree = () => <IncomingShareProvider><Consumer /></IncomingShareProvider>;
  const update = async (changes) => {
    native = { ...native, ...changes };
    await act(async () => { screen.update(tree()); });
  };

  beforeEach(async () => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(appLogger, 'error').mockImplementation(() => {});
    jest.spyOn(appLogger, 'warn').mockImplementation(() => {});
    importSharedContent.mockReset();
    importSharedContent.mockImplementation(async (content) => ({
      drafts: [{ id: content.text, text: content.text }], errors: [],
    }));
    native = {
      hasShareIntent: false, shareIntent: payload(null), error: null,
      resetShareIntent: jest.fn(),
    };
    useShareIntent.mockImplementation(() => native);
  });

  afterEach(async () => {
    if (screen) await act(async () => { screen.unmount(); });
    screen = undefined;
    jest.restoreAllMocks();
  });

  it('imports the initial share and keeps it after the native intent is cleared', async () => {
    native = { ...native, hasShareIntent: true, shareIntent: payload('Cold start') };
    await act(async () => { screen = create(tree()); });
    expect(incoming.drafts).toEqual([{ id: 'Cold start', text: 'Cold start' }]);
    expect(native.resetShareIntent).toHaveBeenCalledTimes(1);
    expect(useShareIntent).toHaveBeenCalledWith(expect.objectContaining({ resetOnBackground: false }));
    await update({ hasShareIntent: false, shareIntent: payload(null) });
    expect(incoming.drafts).toHaveLength(1);
    expect(incoming.isImporting).toBe(false);
  });

  it('does not import duplicate foreground refreshes while files are being read', async () => {
    const loading = deferred();
    importSharedContent.mockReturnValue(loading.promise);
    native = { ...native, hasShareIntent: true, shareIntent: payload('Pending') };
    await act(async () => { screen = create(tree()); });
    await update({ shareIntent: payload('Pending') });
    expect(incoming.isImporting).toBe(true);
    expect(importSharedContent).toHaveBeenCalledTimes(1);
    expect(native.resetShareIntent).not.toHaveBeenCalled();
    await act(async () => { loading.resolve({ drafts: [{ id: 'one', text: 'Pending' }], errors: [] }); });
    expect(incoming.drafts).toHaveLength(1);
    expect(native.resetShareIntent).toHaveBeenCalledTimes(1);
  });

  it('queues a warm share during an import and does not clear it when the old import finishes', async () => {
    const first = deferred();
    const second = deferred();
    importSharedContent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    native = { ...native, hasShareIntent: true, shareIntent: payload('First') };
    await act(async () => { screen = create(tree()); });
    await update({ shareIntent: payload('Second') });
    await act(async () => { first.resolve({ drafts: [{ id: '1', text: 'First' }], errors: [] }); });
    expect(native.resetShareIntent).not.toHaveBeenCalled();
    expect(incoming.isImporting).toBe(true);
    await act(async () => { second.resolve({ drafts: [{ id: '2', text: 'Second' }], errors: [] }); });
    expect(incoming.drafts.map((draft) => draft.text)).toEqual(['First', 'Second']);
    expect(incoming.isImporting).toBe(false);
    expect(native.resetShareIntent).toHaveBeenCalledTimes(1);
    await act(async () => { incoming.removeDraft('1'); });
    expect(incoming.drafts.map((draft) => draft.id)).toEqual(['2']);
  });

  it('accepts an intentional repeat of the same content after consumption', async () => {
    native = { ...native, hasShareIntent: true, shareIntent: payload('Again') };
    await act(async () => { screen = create(tree()); });
    await update({ hasShareIntent: false, shareIntent: payload(null) });
    await update({ hasShareIntent: true, shareIntent: payload('Again') });
    expect(importSharedContent).toHaveBeenCalledTimes(2);
    expect(incoming.drafts).toHaveLength(2);
  });

  it('retains valid content and reports partial import errors', async () => {
    importSharedContent.mockResolvedValue({
      drafts: [{ id: 'valid', text: 'Caption' }], errors: ['Файл слишком большой.'],
    });
    native = { ...native, hasShareIntent: true, shareIntent: payload('Caption') };
    await act(async () => { screen = create(tree()); });
    expect(incoming.drafts).toHaveLength(1);
    expect(appLogger.warn).toHaveBeenCalledWith('chat', 'Файл слишком большой.', { visibleToUser: true });
  });

  it('recovers from an import failure without displaying native error details', async () => {
    importSharedContent.mockRejectedValueOnce(new Error('private shared path'));
    native = { ...native, hasShareIntent: true, shareIntent: payload('Failed') };
    await act(async () => { screen = create(tree()); });
    expect(incoming.isImporting).toBe(false);
    expect(incoming.drafts).toEqual([]);
    expect(appLogger.error).toHaveBeenCalledWith('chat', expect.not.stringContaining('private'), { visibleToUser: true });
    await update({ hasShareIntent: false, shareIntent: payload(null) });
    await update({ hasShareIntent: true, shareIntent: payload('Recovered') });
    expect(incoming.drafts[0].text).toBe('Recovered');
  });

  it('reports native receive failures and consumes their error state', async () => {
    native.error = 'private native error';
    await act(async () => { screen = create(tree()); });
    expect(appLogger.error).toHaveBeenCalledWith('chat', expect.not.stringContaining('private'), { visibleToUser: true });
    expect(native.resetShareIntent).toHaveBeenCalledTimes(1);
  });

  it('does not publish an import result after the provider unmounts', async () => {
    const loading = deferred();
    importSharedContent.mockReturnValue(loading.promise);
    native = { ...native, hasShareIntent: true, shareIntent: payload('Pending') };
    await act(async () => { screen = create(tree()); });
    await act(async () => { screen.unmount(); });
    screen = undefined;
    await act(async () => { loading.resolve({ drafts: [], errors: ['Late error'] }); });
    expect(native.resetShareIntent).not.toHaveBeenCalled();
    expect(appLogger.warn).not.toHaveBeenCalled();
  });
});

describe('share extension routing', () => {
  it.each([true, false])('opens the chat for a share URL (initial=%s)', (initial) => {
    expect(redirectSystemPath({ path: 'chat://dataUrl=chatShareKey#media', initial })).toBe('/');
  });

  it('preserves ordinary application links', () => {
    expect(redirectSystemPath({ path: 'chat://settings', initial: false })).toBe('chat://settings');
  });
});
