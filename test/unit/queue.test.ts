import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Mutex, TrackQueue } from '../../src/queue.ts';
import type { Track } from '../../src/ytmusic/types.ts';

const track = (title: string): Track => ({ videoId: `${title.padEnd(11, '0')}`.slice(0, 11), title, artist: 'Someone', source: 'search' });

describe('TrackQueue', () => {
  it('is first in, first out, with unshift for "play next"', () => {
    const q = new TrackQueue();
    q.push(track('a'), track('b'));
    q.unshift(track('z'));
    assert.deepEqual(q.list().map((t) => t.title), ['z', 'a', 'b']);
    assert.equal(q.shift()?.title, 'z');
    assert.equal(q.length, 2);
  });

  it('removes and moves by 1-based position', () => {
    const q = new TrackQueue();
    q.push(track('a'), track('b'), track('c'), track('d'));
    assert.equal(q.remove(2).title, 'b');
    q.move(3, 1);
    assert.deepEqual(q.list().map((t) => t.title), ['d', 'a', 'c']);
  });

  it('explains bad positions', () => {
    const q = new TrackQueue();
    assert.throws(() => q.remove(1), /queue is empty/);
    q.push(track('a'));
    assert.throws(() => q.remove(2), /No track at position 2; the queue has 1/);
    assert.throws(() => q.remove(0), /No track at position 0/);
  });

  it('returns a copy from list()', () => {
    const q = new TrackQueue();
    q.push(track('a'));
    q.list().pop();
    assert.equal(q.length, 1);
  });

  it('clear() reports how many were removed', () => {
    const q = new TrackQueue();
    q.push(track('a'), track('b'));
    assert.equal(q.clear(), 2);
    assert.equal(q.length, 0);
  });
});

describe('Mutex', () => {
  it('runs jobs one at a time, in order, even when one fails', async () => {
    const mutex = new Mutex();
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) =>
      mutex.run(async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`end ${name}`);
        if (fail) throw new Error(name);
        return name;
      });

    const results = await Promise.allSettled([job('a', 20), job('b', 5, true), job('c', 1)]);
    assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.equal(mutex.busy, false);
  });

  it('reports busy while work is pending', async () => {
    const mutex = new Mutex();
    let release!: () => void;
    const pending = mutex.run(() => new Promise<void>((r) => (release = r)));
    assert.equal(mutex.busy, true);
    await new Promise((r) => setImmediate(r)); // jobs start asynchronously
    release();
    await pending;
    await new Promise((r) => setImmediate(r));
    assert.equal(mutex.busy, false);
  });
});
