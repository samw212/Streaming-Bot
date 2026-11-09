import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GateError } from '../../src/ytmusic/driver.ts';
import { eventually, nextEvent, nextTrack, startHarness, type Harness } from './helpers.ts';

describe('StreamingBot against a fake YouTube Music', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.close();
  });

  it('searches without touching playback, and skips rows that are not playable', async () => {
    const { bot } = await h.newBot();
    const results = await bot.search('the testers');
    assert.deepEqual(
      results.map((t) => t.videoId),
      ['trackAAAA01', 'trackBBBB02'], // top card and its song row are the same video: listed once
    );
    const [alpha] = results;
    assert.equal(alpha?.title, 'Alpha Song');
    assert.equal(alpha?.artist, 'The Testers');
    assert.equal(alpha?.durationSeconds, 2);
    // Merged from the song row: the top card only says "Video" and has no album.
    assert.equal(alpha?.kind, 'Song');
    assert.equal(alpha?.album, 'First Album');
    assert.equal(bot.current, null);
  });

  it('plays the best match for a query and reads what is playing', async () => {
    const { bot } = await h.newBot();
    const track = await bot.play('bravo');
    assert.equal(track.videoId, 'trackBBBB02');
    const snapshot = await eventually(() => bot.snapshot(), (s) => s.status === 'playing');
    assert.equal(snapshot.player?.title, 'Bravo Song');
    assert.equal(snapshot.player?.artist, 'The Testers');
    assert.equal(snapshot.player?.album, 'First Album');
  });

  it('plays queued tracks in order, ahead of YouTube Music autoplay', async () => {
    const { bot } = await h.newBot();
    const played: string[] = [];
    bot.on('trackchange', (t) => played.push(t.videoId));
    await bot.search('song'); // so queued IDs below come with titles, as from the web remote
    await bot.play('alpha');
    const { position } = await bot.enqueue('id:trackCCCC03');
    await bot.enqueue('#2'); // Bravo, from the search above
    assert.equal(position, 1);
    assert.deepEqual(bot.queue.map((t) => t.title), ['Charlie Song', 'Bravo Song']);

    await eventually(async () => played.length, (n) => n >= 3, 10_000);
    assert.deepEqual(played.slice(0, 3), ['trackAAAA01', 'trackCCCC03', 'trackBBBB02']);
    assert.equal(bot.queue.length, 0);
  });

  it('does not mistake the end of a preroll ad for the end of the track', async () => {
    const { bot } = await h.newBot();
    const started = Date.now();
    await bot.play('id:trackADS004');
    await bot.enqueue('id:trackBBBB02');
    await eventually(() => bot.snapshot(), (s) => s.status === 'ad', 2_000);

    const next = await nextTrack(bot, () => true);
    assert.equal(next.videoId, 'trackBBBB02');
    // 1 s ad + 2 s track: if the ad's end had been taken for the track's, this would be ~1 s.
    assert.ok(Date.now() - started >= 2_800, `moved on after only ${Date.now() - started} ms`);
  });

  it('pauses, resumes, seeks and sets the volume', async () => {
    const { bot } = await h.newBot();
    await bot.play('id:trackRAD001');

    await bot.pause();
    assert.equal((await bot.snapshot()).status, 'paused');
    await bot.resume();
    assert.equal((await bot.snapshot()).status, 'playing');

    await bot.seek(12);
    const afterSeek = await bot.snapshot();
    assert.ok(afterSeek.player!.position >= 12 && afterSeek.player!.position < 15, `position ${afterSeek.player!.position}`);

    assert.equal(await bot.setVolume(35), 35);
    assert.equal((await bot.snapshot()).player?.volume, 35);
    assert.equal(await bot.setVolume(250), 100);
  });

  it('keeps the chosen volume across tracks, even though each one reloads the page', async () => {
    const { bot } = await h.newBot();
    await bot.play('id:trackRAD001');
    await bot.setVolume(30);
    await bot.play('id:trackRAD002');
    assert.equal((await bot.snapshot()).player?.volume, 30);
  });

  it('follows YouTube Music autoplay when the queue runs out', async () => {
    const { bot } = await h.newBot({ autoplay: true });
    await bot.play('alpha');
    const next = await nextTrack(bot, () => true);
    assert.equal(next.videoId, 'trackRAD001');
    assert.equal(next.source, 'autoplay');
    assert.equal(next.title, 'Radio Pick One');
  });

  it('stops when the queue runs out if autoplay is off', async () => {
    const { bot } = await h.newBot({ autoplay: false });
    await bot.play('alpha');
    await nextEvent(bot, 'idle');
    const snapshot = await eventually(() => bot.snapshot(), (s) => s.player?.isPlaying === false);
    assert.equal(snapshot.status, 'idle');
    assert.equal(snapshot.current, null);
  });

  it('skips to YouTube Music’s pick when nothing is queued', async () => {
    const { bot } = await h.newBot();
    await bot.play('id:trackRAD001');
    const next = await bot.next();
    assert.equal(next?.videoId, 'trackRAD002');
    assert.equal(next?.source, 'autoplay');
  });

  it('goes back through history, keeping the skipped track up next', async () => {
    const { bot } = await h.newBot();
    await bot.play('id:trackRAD001');
    await bot.play('id:trackRAD002');
    const back = await bot.previous();
    assert.equal(back?.videoId, 'trackRAD001');
    assert.equal(bot.queue[0]?.videoId, 'trackRAD002');
  });

  it('notices when someone changes the song in the browser window', async () => {
    const { bot, driver } = await h.newBot();
    await bot.play('id:trackRAD001');
    const changed = nextTrack(bot, () => true);
    await driver.page.click('ytmusic-player-bar .next-button');
    const track = await changed;
    assert.equal(track.videoId, 'trackRAD002');
    assert.equal(track.source, 'browser');
  });

  it('plays through a playlist link', async () => {
    const { bot } = await h.newBot();
    const first = await bot.play('https://music.youtube.com/playlist?list=PLtest00001');
    assert.equal(first.videoId, 'trackBBBB02');
    const second = await nextTrack(bot, () => true);
    assert.equal(second.videoId, 'trackCCCC03');
  });

  it('explains bad input instead of guessing', async () => {
    const { bot } = await h.newBot();
    await assert.rejects(bot.play('#4'), /no search results to pick #4/);
    await assert.rejects(bot.play('zzz nothing matches'), /No playable results/);
    await assert.rejects(bot.resume(), /Nothing to resume/);
  });

  it('reports a track that fails to load and is left idle, not pretending the old one plays', async () => {
    const { bot } = await h.newBot();
    await bot.play('id:trackRAD001');
    await assert.rejects(bot.play('id:missing0000'), /didn't load|didn't start/);
    const snapshot = await bot.snapshot();
    assert.equal(snapshot.current, null);
    assert.equal(snapshot.status, 'idle');
    assert.match(snapshot.lastError ?? '', /.+/);
  });

  it('fails fast on a CAPTCHA page when nobody can see the browser', async () => {
    const { bot } = await h.newBot({ interactive: false });
    await assert.rejects(bot.search('blocked'), (error: unknown) => {
      assert.ok(error instanceof GateError);
      assert.equal(error.gate, 'captcha');
      assert.match(error.message, /unusual traffic/);
      return true;
    });
  });

  it('waits for a person to clear a CAPTCHA page, then carries on', async () => {
    const { bot } = await h.newBot({ interactive: true, gateTimeoutMs: 10_000 });
    const existingTabs = new Set(h.session.context.pages());
    const search = bot.search('blocked');
    // Play the part of the person at the keyboard, in the search tab the bot just opened.
    const gatePage = await eventually(
      async () => h.session.context.pages().find((p) => !existingTabs.has(p) && p.url().includes('/sorry/')),
      (p) => p !== undefined,
    );
    await gatePage!.click('#solve');
    assert.deepEqual(await search, []); // the fake has no tracks matching "blocked"
    await h.session.context.clearCookies();
  });
});
