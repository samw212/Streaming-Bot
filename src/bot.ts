import { EventEmitter } from 'node:events';
import { errorMessage, type Logger } from './logger.ts';
import { Mutex, TrackQueue } from './queue.ts';
import { GateError, pickBestResult, type YTMusicDriver } from './ytmusic/driver.ts';
import { parseTarget } from './ytmusic/parse.ts';
import type { MediaEndedEvent, PlayerState, Track, TrackSource } from './ytmusic/types.ts';

export type BotStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ad';

export interface BotSnapshot {
  status: BotStatus;
  current: Track | null;
  player: PlayerState | null;
  queue: Track[];
  historySize: number;
  autoplay: boolean;
  lastError: string | null;
}

export interface BotOptions {
  /** When the bot's own queue runs out, let YouTube Music keep going with its Up Next / radio. */
  autoplay: boolean;
  logger: Logger;
  /** Volume (0-100) to play at. Without it, YouTube Music's own setting is left alone. */
  initialVolume?: number;
  pollIntervalMs?: number;
}

type BotEvents = {
  trackchange: [track: Track];
  idle: [];
  error: [error: Error];
};

const HISTORY_LIMIT = 50;
const KNOWN_TRACKS_LIMIT = 500;
/** A track counts as "finished" if it was this close to its end when it changed. */
const NEAR_END_SECONDS = 5;

/**
 * The player's brain: a queue on top of YouTube Music.
 *
 * Everything that changes playback goes through one mutex, so commands from the REPL, the
 * HTTP API and track-end events can arrive at the same time without fighting each other.
 * Track ends are picked up two ways: an in-page `ended` listener (fast) and a 1s poll that
 * also notices when someone changes the song in the browser window.
 */
export class StreamingBot extends EventEmitter<BotEvents> {
  readonly #driver: YTMusicDriver;
  readonly #log: Logger;
  readonly #lock = new Mutex();
  readonly #queue = new TrackQueue();
  readonly #pollIntervalMs: number;
  #history: Track[] = [];
  #current: Track | null = null;
  #state: PlayerState | null = null;
  #lastSearch: Track[] = [];
  #known = new Map<string, Track>();
  #autoplay: boolean;
  /** The volume the user asked for; re-applied after each page load. */
  #volume: number | undefined;
  #loading = false;
  #lastError: string | null = null;
  #endedVideoId: string | null = null;
  #ignoreEndedUntil = 0;
  #ignorePlayingUntil = 0;
  #pollTimer: NodeJS.Timeout | null = null;
  #polling = false;

  constructor(driver: YTMusicDriver, options: BotOptions) {
    super();
    this.#driver = driver;
    this.#log = options.logger;
    this.#autoplay = options.autoplay;
    this.#volume = options.initialVolume;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  async start(): Promise<void> {
    await this.#driver.onMediaEnded((event) => this.#onMediaEnded(event));
    await this.#driver.openHome();
    this.#pollTimer = setInterval(() => void this.#poll(), this.#pollIntervalMs);
    this.#pollTimer.unref();
  }

  stop(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  // --------------------------------------------------------------- queries

  get autoplay(): boolean {
    return this.#autoplay;
  }

  get current(): Track | null {
    return this.#current;
  }

  get queue(): Track[] {
    return this.#queue.list();
  }

  /** Current snapshot, refreshing the player state if nothing else is mid-change. */
  async snapshot(): Promise<BotSnapshot> {
    if (!this.#lock.busy && !this.#loading) await this.#refreshState();
    return {
      status: this.#status(),
      current: this.#current,
      player: this.#state,
      queue: this.#queue.list(),
      historySize: this.#history.length,
      autoplay: this.#autoplay,
      lastError: this.#lastError,
    };
  }

  /** Searches without touching playback. Results can be referred to later as #1, #2, ... */
  async search(query: string, limit = 10): Promise<Track[]> {
    const results = await this.#driver.search(query, limit);
    for (const track of results) this.#remember(track);
    this.#lastSearch = results;
    return results;
  }

  // -------------------------------------------------------------- commands

  /** Play something right now. What was playing goes into history. */
  async play(input: string): Promise<Track> {
    const track = await this.resolve(input);
    return this.#lock.run(async () => {
      this.#pushHistory();
      return this.#playTrack(track);
    });
  }

  /** Add to the end of the queue (or the front, with `next`). Starts playing if idle. */
  async enqueue(input: string, options: { next?: boolean } = {}): Promise<{ track: Track; position: number; started: boolean }> {
    const track = await this.resolve(input);
    return this.#lock.run(async () => {
      if (!this.#current) {
        await this.#playTrack(track);
        return { track, position: 0, started: true };
      }
      if (options.next) this.#queue.unshift(track);
      else this.#queue.push(track);
      return { track, position: options.next ? 1 : this.#queue.length, started: false };
    });
  }

  /** Skip to the next queued track, or let YouTube Music pick one if autoplay is on. */
  async next(): Promise<Track | null> {
    return this.#lock.run(async () => {
      if (this.#queue.length > 0) {
        this.#pushHistory();
        return this.#playNextQueued();
      }
      if (!this.#autoplay || !this.#current) {
        await this.#becomeIdle();
        return null;
      }
      const from = this.#current.videoId;
      await this.#driver.next();
      const state = await this.#driver.waitForVideoChange(from);
      this.#pushHistory();
      return this.#adopt(state, 'autoplay');
    });
  }

  /** Restart the track if it's past the first few seconds, otherwise go back to the previous one. */
  async previous(): Promise<Track | null> {
    return this.#lock.run(async () => {
      const position = (await this.#refreshState())?.position ?? 0;
      const previous = this.#history.at(-1);
      if (position > 5 || !previous) {
        if (this.#current) await this.#driver.seek(0);
        return this.#current;
      }
      this.#history.pop();
      if (this.#current) this.#queue.unshift(this.#current);
      return this.#playTrack(previous);
    });
  }

  async pause(): Promise<void> {
    await this.#lock.run(() => this.#driver.pause());
  }

  async resume(): Promise<void> {
    await this.#lock.run(async () => {
      if (!this.#current) {
        if (this.#queue.length > 0) await this.#playNextQueued();
        else throw new Error('Nothing to resume: the queue is empty. Try "play <song>".');
        return;
      }
      await this.#driver.resume();
    });
  }

  async toggle(): Promise<'playing' | 'paused'> {
    const state = await this.#refreshState();
    if (state?.isPlaying) {
      await this.pause();
      return 'paused';
    }
    await this.resume();
    return 'playing';
  }

  async setVolume(level: number): Promise<number> {
    if (!Number.isFinite(level)) throw new Error('Volume must be a number from 0 to 100.');
    const volume = Math.round(Math.min(100, Math.max(0, level)));
    await this.#lock.run(async () => {
      this.#volume = volume; // also applied to whatever plays next
      if (this.#current) await this.#driver.setVolume(volume);
    });
    return volume;
  }

  async seek(seconds: number): Promise<void> {
    await this.#lock.run(async () => {
      if (!this.#current) throw new Error('Nothing is playing.');
      await this.#driver.seek(seconds);
    });
  }

  removeFromQueue(position: number): Track {
    return this.#queue.remove(position);
  }

  moveInQueue(from: number, to: number): void {
    this.#queue.move(from, to);
  }

  clearQueue(): number {
    return this.#queue.clear();
  }

  setAutoplay(enabled: boolean): void {
    this.#autoplay = enabled;
  }

  /** Stop playback and forget the current track. The queue is kept. */
  async stopPlayback(): Promise<void> {
    await this.#lock.run(() => this.#becomeIdle());
  }

  /** Turns user input (query, URL, ID, #N) into a track, searching if needed. */
  async resolve(input: string): Promise<Track> {
    const target = parseTarget(input);
    switch (target.kind) {
      case 'searchRef': {
        const track = this.#lastSearch[target.index - 1];
        if (!track) {
          throw new Error(
            this.#lastSearch.length === 0
              ? `There are no search results to pick #${target.index} from. Run "search <query>" first.`
              : `The last search only had ${this.#lastSearch.length} results.`,
          );
        }
        return { ...track };
      }
      case 'video': {
        const known = this.#known.get(target.videoId);
        const track: Track = known
          ? { ...known }
          : { videoId: target.videoId, title: '', artist: '', source: 'url' };
        if (target.playlistId) track.playlistId = target.playlistId;
        return track;
      }
      case 'playlist':
        return { videoId: '', playlistId: target.playlistId, title: '', artist: '', source: 'url' };
      case 'query': {
        // Not this.search(): an implicit search mustn't change what #N refers to.
        const results = await this.#driver.search(target.query, 10);
        for (const track of results) this.#remember(track);
        const best = pickBestResult(results);
        if (!best) throw new Error(`No playable results for "${target.query}".`);
        return { ...best };
      }
    }
  }

  // ------------------------------------------------------------- internals
  // Methods below assume the caller holds #lock.

  async #playTrack(track: Track): Promise<Track> {
    this.#loading = true;
    this.#lastError = null;
    this.#ignoreEndedUntil = Date.now() + 2_000;
    try {
      if (track.videoId) await this.#driver.playVideo(track.videoId, track.playlistId);
      else if (track.playlistId) await this.#driver.playPlaylist(track.playlistId);
      else throw new Error('Track has neither a video nor a playlist ID.');
    } catch (error) {
      // The page has left whatever was playing before, so nothing is playing now.
      this.#current = null;
      this.#ignorePlayingUntil = Date.now() + 3_000;
      this.#lastError = errorMessage(error);
      throw error;
    } finally {
      this.#loading = false;
    }

    const state = await this.#refreshState();
    const current: Track = { ...track, videoId: track.videoId || state?.videoId || '' };
    if (state) fillFromState(current, state);
    this.#current = current;
    this.#remember(current);

    // Loading a track reloads the page, which can reset the volume.
    if (this.#volume !== undefined && state?.volume !== this.#volume) {
      await this.#driver.setVolume(this.#volume).catch((e) => this.#log.warn(`Couldn't set volume: ${errorMessage(e)}`));
      await this.#refreshState();
    }

    this.emit('trackchange', current);
    return current;
  }

  /** Plays queued tracks until one works. Gate errors stop immediately since every track would hit them. */
  async #playNextQueued(): Promise<Track | null> {
    let track: Track | undefined;
    while ((track = this.#queue.shift())) {
      try {
        return await this.#playTrack(track);
      } catch (error) {
        this.#log.error(`Couldn't play "${describe(track)}": ${errorMessage(error)}`);
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
        if (error instanceof GateError) break;
      }
    }
    await this.#becomeIdle();
    return null;
  }

  async #becomeIdle(): Promise<void> {
    this.#pushHistory();
    this.#current = null;
    this.#ignorePlayingUntil = Date.now() + 3_000;
    await this.#driver.pause().catch(() => {}); // fine if nothing was loaded
    this.emit('idle');
  }

  #adopt(state: PlayerState, source: TrackSource): Track {
    const known = state.videoId ? this.#known.get(state.videoId) : undefined;
    const track: Track = known
      ? { ...known, source }
      : { videoId: state.videoId ?? '', title: '', artist: '', source };
    fillFromState(track, state);
    this.#current = track;
    this.#remember(track);
    this.emit('trackchange', track);
    return track;
  }

  #pushHistory(): void {
    if (!this.#current) return;
    this.#history.push(this.#current);
    if (this.#history.length > HISTORY_LIMIT) this.#history.shift();
  }

  #remember(track: Track): void {
    if (!track.videoId) return;
    this.#known.delete(track.videoId);
    this.#known.set(track.videoId, track);
    if (this.#known.size > KNOWN_TRACKS_LIMIT) {
      const oldest = this.#known.keys().next().value;
      if (oldest !== undefined) this.#known.delete(oldest);
    }
  }

  async #refreshState(): Promise<PlayerState | null> {
    try {
      this.#state = await this.#driver.readState();
    } catch {
      // The page is mid-navigation; keep the last known state.
    }
    return this.#state;
  }

  #status(): BotStatus {
    if (this.#loading) return 'loading';
    if (!this.#current) return 'idle';
    if (this.#state?.isAd) return 'ad';
    return this.#state?.isPlaying ? 'playing' : 'paused';
  }

  // ---------------------------------------------------- track-end handling

  #onMediaEnded(event: MediaEndedEvent): void {
    const current = this.#current;
    if (event.isAd || Date.now() < this.#ignoreEndedUntil) return;
    if (!current || event.videoId !== current.videoId) return;
    // A preroll ad that ends while the URL already shows the track would otherwise look like the
    // track ending. If we know the track's length, the media that just ended must roughly match it.
    if (current.durationSeconds && event.duration > 0 && Math.abs(event.duration - current.durationSeconds) > 10) return;

    this.#endedVideoId = current.videoId;
    this.#log.debug(`Finished ${describe(current)}`);
    if (this.#queue.length === 0) return; // YouTube Music's autoplay (or the poll) takes it from here.

    void this.#lock
      .run(async () => {
        if (this.#current?.videoId !== event.videoId) return; // something else already moved on
        this.#pushHistory();
        await this.#playNextQueued();
      })
      .catch((error) => this.#log.error(`Couldn't advance the queue: ${errorMessage(error)}`));
  }

  async #poll(): Promise<void> {
    if (this.#polling || this.#lock.busy || this.#loading) return;
    this.#polling = true;
    try {
      const previous = this.#state;
      const state = await this.#refreshState();
      if (!state || state === previous || !state.videoId || state.isAd) return;
      const current = this.#current;

      if (current && current.videoId && state.videoId !== current.videoId) {
        const finished =
          this.#endedVideoId === current.videoId ||
          (previous?.videoId === current.videoId &&
            previous.duration > 0 &&
            previous.position >= previous.duration - NEAR_END_SECONDS);
        await this.#lock.run(() => this.#handleExternalChange(state.videoId!, finished));
      } else if (!current && state.isPlaying && Date.now() > this.#ignorePlayingUntil) {
        // Someone started music from the browser window while the bot was idle.
        await this.#lock.run(async () => {
          if (!this.#current) this.#adopt(state, 'browser');
        });
      } else if (current && state.videoId === current.videoId) {
        fillFromState(current, state);
        // Someone moved the volume slider in the browser window: keep their choice from now on.
        if (this.#volume !== undefined && previous?.videoId === state.videoId && state.volume !== previous.volume) {
          this.#volume = state.volume;
        }
      }
    } catch (error) {
      this.#log.debug(`Poll failed: ${errorMessage(error)}`);
    } finally {
      this.#polling = false;
    }
  }

  /** The player moved to a different video without the bot asking it to. */
  async #handleExternalChange(newVideoId: string, finished: boolean): Promise<void> {
    if (!this.#current || this.#current.videoId === newVideoId) return; // already handled
    this.#endedVideoId = null;

    if (finished && this.#queue.length > 0) {
      this.#pushHistory();
      await this.#playNextQueued();
      return;
    }
    if (finished && !this.#autoplay) {
      this.#log.info('Queue finished.');
      await this.#becomeIdle();
      return;
    }
    const state = await this.#refreshState();
    if (!state || state.videoId !== newVideoId) return;
    this.#pushHistory();
    this.#adopt(state, finished ? 'autoplay' : 'browser');
  }
}

/** Copies metadata the player knows about into a track, without overwriting good data with blanks. */
function fillFromState(track: Track, state: PlayerState): void {
  if (state.isAd || state.videoId !== track.videoId) return;
  if (!track.title && state.title) track.title = state.title;
  if (!track.artist && state.artist) track.artist = state.artist;
  if (!track.album && state.album) track.album = state.album;
  if (!track.thumbnail && state.artwork) track.thumbnail = state.artwork;
  if (!track.durationSeconds && state.duration > 0) track.durationSeconds = Math.round(state.duration);
}

export function describe(track: Track): string {
  const title = track.title || (track.videoId ? `video ${track.videoId}` : `playlist ${track.playlistId ?? ''}`);
  return track.artist ? `${title} — ${track.artist}` : title;
}
