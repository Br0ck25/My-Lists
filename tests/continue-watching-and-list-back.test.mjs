import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, requestsTo } from './client-harness.mjs';

describe('Continue Watching sync matches the local Live Preview', () => {
  it('detects an episode changing in place on the same show', () => {
    const client = loadClient();
    const cw = (episodeNum) => ({
      'continue-watching': { items: [{ id: 'tt123:1:1', showId: 'tt123', seasonNum: 1, episodeNum, airDate: '2026-09-26' }] },
    });
    assert.notEqual(client.call('trackingSyncSignature', cw(2)), client.call('trackingSyncSignature', cw(3)),
      'same show, item id and count must still sync the next episode to installed catalogs');
    assert.notEqual(client.call('trackingSyncSignature', cw(3)),
      client.call('trackingSyncSignature', { 'continue-watching': { items: [{ ...cw(3)['continue-watching'].items[0], airDate: '2026-09-27' }] } }),
      'an updated air date/badge must also sync');
  });

  it('does not mark a rejected save as synced (so the next push retries)', async () => {
    const client = loadClient({
      storage: { 'myListAddon:creatorKey': 'key' },
      routes: { '/api/creator/sync/save-tracking': () => ({ status: 500, json: { ok: false, error: 'temporarily unavailable' } }) },
    });
    client.set('activeCreator', { creatorName: 'alice' });
    client.call('markCreatorSyncLoaded');
    await client.call('pushTrackingSync');
    await client.call('pushTrackingSync');
    assert.equal(requestsTo(client, '/api/creator/sync/save-tracking').length, 2);
    assert.equal(client.get('window._lastTrackingSig'), undefined);
  });
});

describe('See All back navigation', () => {
  it('keeps the full list identity in history and returns to the deep poster without refetching page one', async () => {
    const client = loadClient();
    const pushed = [];
    client.history.pushState = (state, _title, url) => pushed.push({ state, url });
    const longUrl = 'customlist:v1:' + 'x'.repeat(1600);
    const items = Array.from({ length: 220 }, (_, i) => ({ id: 'tt' + i, type: 'movie', name: 'Movie ' + i }));
    await client.call('openListDetailsPage', 'Large list', 'movie', longUrl, { sample: items, maybeMore: false });
    const list = pushed.at(-1);
    assert.equal(list.state.listUrl, longUrl, 'history.state must retain the URL even when the address bar omits it');
    assert.ok(!list.url.includes(longUrl), 'do not put an embedded list in the address bar');
    const grid = client.document.getElementById('detailGrid');
    grid.children = [{ id: 'poster-deep-in-list' }];
    client.document.getElementById('content-list-details').hidden = false;
    const positions = [];
    client.scrollTo = ({ top }) => positions.push(top);
    client.scrollY = 7200;
    client.document.querySelector = (sel) => sel === '.tab-panel:not([hidden])'
      ? { dataset: { tabPanel: 'list-details' } } : null;
    // Opening the poster captures where the user was, before hiding the grid.
    // The network request for item details can fail in this test; navigation
    // already happened by then.
    await client.call('openItemDetailsModal', 'tt200', 'movie');
    client.location.hash = list.url.slice(1);
    client.dispatchEvent({ type: 'popstate', state: list.state });
    assert.equal(positions.at(-1), 7200);
    assert.equal(client.get('window._currentListDetailsAllItems').length, 220,
      'back must reuse the full rendered grid, not reset See All to its first page');
    assert.equal(requestsTo(client, '/api/preview').length, 0);
  });
});

describe('Continue Watching startup reconciliation', () => {
  it('does not overwrite the correct local shelf with an older server merge at the same version', async () => {
    const local = [
      { id: 'tt-ark:1:3', showId: 'tt-ark', type: 'episode', seasonNum: 1, episodeNum: 3 },
      { id: 'tt-see:1:2', showId: 'tt-see', type: 'episode', seasonNum: 1, episodeNum: 2 },
    ];
    const client = loadClient({
      storage: {
        'myListAddon:creatorKey': 'key',
        'myListAddon:localCustomLists': JSON.stringify({
          'continue-watching': { slug: 'continue-watching', items: local, updatedAt: 5000 },
        }),
      },
      routes: {
        '/api/creator/sync/load': () => ({ json: { ok: true, data: {
          trackingUpdatedAt: 5000,
          continueWatching: [
            { id: 'tt-ark:1:2', showId: 'tt-ark', type: 'episode', seasonNum: 1, episodeNum: 2 },
            { id: 'tt-revival:1:1', showId: 'tt-revival', type: 'episode', seasonNum: 1, episodeNum: 1 },
          ],
          fullyWatchedShowIds: ['tt-see'],
        } } }),
        '/api/creator/lists': () => ({ json: { ok: true, lists: [] } }),
      },
    });
    client.set('activeCreator', { creatorName: 'alice' });
    client.set('window._serverTrackingUpdatedAt', 5000);
    await client.call('loadCreatorSync');
    const cw = client.get("loadLocalCustomLists()['continue-watching'].items");
    assert.deepEqual(cw.map(it => it.showId), ['tt-ark', 'tt-see']);
    assert.equal(cw[0].episodeNum, 3);
    assert.equal(client.get('window._fullyWatchedShowIds').has('tt-see'), false);
  });
});
