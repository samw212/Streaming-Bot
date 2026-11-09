import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatDuration,
  looksLikeVideoId,
  parseDuration,
  parseSeek,
  parseSubtitle,
  parseTarget,
  parseYouTubeUrl,
} from '../../src/ytmusic/parse.ts';
import { detectGate } from '../../src/ytmusic/selectors.ts';

describe('parseYouTubeUrl', () => {
  it('reads music.youtube.com watch links, with and without a playlist', () => {
    assert.deepEqual(parseYouTubeUrl('https://music.youtube.com/watch?v=5NV6Rdv1a3I'), { kind: 'video', videoId: '5NV6Rdv1a3I' });
    assert.deepEqual(parseYouTubeUrl('https://music.youtube.com/watch?v=5NV6Rdv1a3I&list=RDAMVM5NV6Rdv1a3I'), {
      kind: 'video',
      videoId: '5NV6Rdv1a3I',
      playlistId: 'RDAMVM5NV6Rdv1a3I',
    });
  });

  it('reads youtube.com, youtu.be, shorts and scheme-less links', () => {
    assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42'), { kind: 'video', videoId: 'dQw4w9WgXcQ' });
    assert.deepEqual(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?si=abc'), { kind: 'video', videoId: 'dQw4w9WgXcQ' });
    assert.deepEqual(parseYouTubeUrl('youtube.com/shorts/dQw4w9WgXcQ'), { kind: 'video', videoId: 'dQw4w9WgXcQ' });
    assert.deepEqual(parseYouTubeUrl('m.youtube.com/watch?v=dQw4w9WgXcQ'), { kind: 'video', videoId: 'dQw4w9WgXcQ' });
  });

  it('reads playlist links', () => {
    assert.deepEqual(parseYouTubeUrl('https://music.youtube.com/playlist?list=PL1234567890'), { kind: 'playlist', playlistId: 'PL1234567890' });
  });

  it('ignores other sites and plain text', () => {
    assert.equal(parseYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null);
    assert.equal(parseYouTubeUrl('daft punk get lucky'), null);
    assert.equal(parseYouTubeUrl('youtube.com'), null);
    assert.equal(parseYouTubeUrl('https://youtube.com/watch?v=short'), null);
  });
});

describe('parseTarget', () => {
  it('treats ordinary text as a search query', () => {
    assert.deepEqual(parseTarget('  daft punk get lucky '), { kind: 'query', query: 'daft punk get lucky' });
  });

  it('does not mistake 11-letter words for video IDs', () => {
    assert.deepEqual(parseTarget('underground'), { kind: 'query', query: 'underground' });
    assert.deepEqual(parseTarget('Underground'), { kind: 'query', query: 'Underground' });
    assert.equal(looksLikeVideoId('temperature'), false);
  });

  it('accepts bare IDs that look random, and explicit id: prefixes', () => {
    assert.deepEqual(parseTarget('dQw4w9WgXcQ'), { kind: 'video', videoId: 'dQw4w9WgXcQ' });
    assert.deepEqual(parseTarget('id:underground'), { kind: 'video', videoId: 'underground' });
    assert.throws(() => parseTarget('id:nope'), /not a valid YouTube video ID/);
  });

  it('reads #N as a reference to the last search', () => {
    assert.deepEqual(parseTarget('#3'), { kind: 'searchRef', index: 3 });
    assert.deepEqual(parseTarget('#3 days grace'), { kind: 'query', query: '#3 days grace' });
  });

  it('rejects empty input', () => {
    assert.throws(() => parseTarget('   '), /Nothing to play/);
  });
});

describe('durations', () => {
  it('parses m:ss and h:mm:ss', () => {
    assert.equal(parseDuration('3:45'), 225);
    assert.equal(parseDuration('0:07'), 7);
    assert.equal(parseDuration('1:02:03'), 3723);
    assert.equal(parseDuration('3:4'), undefined);
    assert.equal(parseDuration('1.9M views'), undefined);
  });

  it('formats seconds', () => {
    assert.equal(formatDuration(225), '3:45');
    assert.equal(formatDuration(3723), '1:02:03');
    assert.equal(formatDuration(59.9), '0:59');
    assert.equal(formatDuration(Number.NaN), '0:00');
  });
});

describe('parseSubtitle', () => {
  it('reads a song row', () => {
    assert.deepEqual(parseSubtitle('Song • Daft Punk • Random Access Memories • 6:09'), {
      kind: 'Song',
      artist: 'Daft Punk',
      album: 'Random Access Memories',
      durationSeconds: 369,
    });
  });

  it('reads a video row, dropping view counts', () => {
    assert.deepEqual(parseSubtitle('Video • Nile Rodgers, Pharrell & Daft Punk • 1.9M views'), {
      kind: 'Video',
      artist: 'Nile Rodgers, Pharrell & Daft Punk',
    });
  });

  it('copes with messy whitespace and rows without a type', () => {
    assert.deepEqual(parseSubtitle('  Daft Punk\n •  Discovery  •  2001 • 3:45 '), {
      artist: 'Daft Punk',
      album: 'Discovery',
      durationSeconds: 225,
    });
    assert.deepEqual(parseSubtitle(''), { artist: '' });
  });
});

describe('parseSeek', () => {
  it('handles absolute and relative positions', () => {
    assert.equal(parseSeek('90', 10), 90);
    assert.equal(parseSeek('1:30', 10), 90);
    assert.equal(parseSeek('+15', 10), 25);
    assert.equal(parseSeek('-15', 10), 0);
    assert.equal(parseSeek('-0:05', 30), 25);
    assert.throws(() => parseSeek('soon', 0), /Can't understand seek position/);
  });
});

describe('detectGate', () => {
  it('recognises the pages Google can put in front of YouTube Music', () => {
    assert.equal(detectGate('https://www.google.com/sorry/index?continue=https://music.youtube.com/'), 'captcha');
    assert.equal(detectGate('https://consent.youtube.com/m?continue=https://music.youtube.com/'), 'consent');
    assert.equal(detectGate('https://accounts.google.com/ServiceLogin'), 'signin');
    assert.equal(detectGate('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), null);
    assert.equal(detectGate('not a url'), null);
  });
});
