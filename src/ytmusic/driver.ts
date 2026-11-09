import type { BrowserContext, Page } from 'playwright';
import { errorMessage, type Logger } from '../logger.ts';
import { Mutex } from '../queue.ts';
import { parseSubtitle } from './parse.ts';
import { detectGate, GATE_MESSAGES, SELECTORS, urls, type GateKind, type Selectors } from './selectors.ts';
import type { MediaEndedEvent, PlayerState, Track } from './types.ts';

/** Raised when Google puts a CAPTCHA, consent or sign-in page in front of YouTube Music. */
export class GateError extends Error {
  readonly gate: GateKind;
  constructor(gate: GateKind, message: string) {
    super(message);
    this.name = 'GateError';
    this.gate = gate;
  }
}

export interface DriverOptions {
  baseUrl: string;
  /**
   * True when a person can see the browser window. Gates are then handed to them to resolve;
   * otherwise they fail fast with a GateError.
   */
  interactive: boolean;
  gateTimeoutMs: number;
  navigationTimeoutMs: number;
  logger: Logger;
}

/** The parts of YouTube's player API we use, all optional because none of it is documented. */
interface YouTubePlayerApi {
  getVideoData?: () => { video_id?: string } | undefined;
  getVolume?: () => number;
  setVolume?: (volume: number) => void;
  isMuted?: () => boolean;
  unMute?: () => void;
  seekTo?: (seconds: number, allowSeekAhead: boolean) => void;
  nextVideo?: () => void;
  previousVideo?: () => void;
}

interface RawResult {
  videoId: string;
  playlistId: string | null;
  title: string;
  subtitle: string;
  thumbnail: string;
}

const BINDING = '__ytmBotEmit';

/**
 * Browser-side listener for the end of media playback. `ended` doesn't bubble, so it is caught
 * in the capture phase on the document, which also covers <video> elements created later.
 */
const ENDED_LISTENER = `(() => {
  const adClasses = ${JSON.stringify(SELECTORS.adClasses)};
  document.addEventListener('ended', (event) => {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement) || typeof window.${BINDING} !== 'function') return;
    const player = document.querySelector(${JSON.stringify(SELECTORS.player)});
    const isAd = !!player && adClasses.some((c) => player.classList.contains(c));
    let videoId = null;
    try { videoId = new URL(location.href).searchParams.get('v'); } catch {}
    window.${BINDING}({ videoId, isAd, duration: Number.isFinite(media.duration) ? media.duration : 0 });
  }, true);
})();`;

/**
 * Low-level control of YouTube Music through Playwright. It knows about pages, selectors and
 * timing, but nothing about queues or policy (that's StreamingBot's job).
 *
 * Playback lives in one tab; searches run in a second tab so they never interrupt the music.
 */
export class YTMusicDriver {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly #opts: DriverOptions;
  readonly #log: Logger;
  readonly #searchLock = new Mutex();
  #searchPage: Page | null = null;

  constructor(context: BrowserContext, page: Page, options: DriverOptions) {
    this.context = context;
    this.page = page;
    this.#opts = options;
    this.#log = options.logger;
  }

  get baseUrl(): string {
    return this.#opts.baseUrl;
  }

  /** Registers a callback for "a <video> on the player page reached its end". Call before navigating. */
  async onMediaEnded(callback: (event: MediaEndedEvent) => void): Promise<void> {
    await this.page.exposeBinding(BINDING, (_source, payload: MediaEndedEvent) => callback(payload));
    await this.page.addInitScript(ENDED_LISTENER);
  }

  async openHome(): Promise<void> {
    await this.#goto(this.page, urls.home(this.baseUrl));
  }

  // ---------------------------------------------------------------- search

  async search(query: string, limit = 10): Promise<Track[]> {
    return this.#searchLock.run(async () => {
      const page = await this.#getSearchPage();
      try {
        await this.#goto(page, urls.search(this.baseUrl, query));
        const settled = `${SELECTORS.resultItem}, ${SELECTORS.topResultCard}, ${SELECTORS.noResults}`;
        const found = await page
          .waitForSelector(settled, { state: 'attached', timeout: this.#opts.navigationTimeoutMs })
          .then(() => true, () => false);
        if (!found) {
          await this.#handleGate(page);
          this.#log.warn(`Search results for "${query}" didn't appear; YouTube Music's page may have changed.`);
          return [];
        }
        // Shelves render in quick succession; give the rest of the page a moment to fill in.
        await page.waitForTimeout(300);
        let raw = await page.evaluate(extractSearchResults, SELECTORS);
        if (raw.length === 0) {
          // An empty-state message can show briefly before results arrive; allow them a little longer.
          const playable = `${SELECTORS.resultItem} ${SELECTORS.watchLink}, ${SELECTORS.topResultCard} ${SELECTORS.watchLink}`;
          if (await page.waitForSelector(playable, { state: 'attached', timeout: 3_000 }).then(() => true, () => false)) {
            await page.waitForTimeout(300);
            raw = await page.evaluate(extractSearchResults, SELECTORS);
          }
        }
        return toTracks(raw).slice(0, limit);
      } finally {
        // In a visible window, searching opens a tab in front of the player; put the player back.
        if (this.#opts.interactive) await this.page.bringToFront().catch(() => {});
      }
    });
  }

  async #getSearchPage(): Promise<Page> {
    if (!this.#searchPage || this.#searchPage.isClosed()) {
      this.#searchPage = await this.context.newPage();
    }
    return this.#searchPage;
  }

  // -------------------------------------------------------------- playback

  async playVideo(videoId: string, playlistId?: string): Promise<void> {
    await this.#goto(this.page, urls.watch(this.baseUrl, videoId, playlistId));
    await this.#waitForPlayback(videoId);
  }

  async playPlaylist(playlistId: string): Promise<void> {
    await this.#goto(this.page, urls.playlist(this.baseUrl, playlistId));
    await this.#waitForPlayback(null);
  }

  async readState(): Promise<PlayerState> {
    return this.page.evaluate(readPlayerState, SELECTORS);
  }

  async pause(): Promise<void> {
    await this.#setPlaying(false);
  }

  async resume(): Promise<void> {
    await this.#setPlaying(true);
  }

  /** YouTube Music's own "next": follows its Up Next list, playlist or radio. */
  async next(): Promise<void> {
    if (await this.#click(SELECTORS.nextButton)) return;
    await this.#callPlayer('nextVideo');
  }

  /** YouTube Music's own "previous": restarts the track, or goes back if near the start. */
  async previous(): Promise<void> {
    if (await this.#click(SELECTORS.previousButton)) return;
    await this.#callPlayer('previousVideo');
  }

  async setVolume(level: number): Promise<void> {
    const volume = Math.round(Math.min(100, Math.max(0, level)));
    await this.page.evaluate(
      ({ sel, volume }) => {
        const player = document.querySelector(sel.player) as (Element & YouTubePlayerApi) | null;
        if (player && typeof player.setVolume === 'function') {
          player.setVolume(volume);
          if (volume > 0 && player.isMuted?.()) player.unMute?.();
          return;
        }
        const video = document.querySelector<HTMLVideoElement>(sel.video);
        if (!video) throw new Error('Nothing is loaded yet; play something before changing the volume.');
        video.volume = volume / 100;
        if (volume > 0) video.muted = false;
      },
      { sel: SELECTORS, volume },
    );
  }

  async seek(seconds: number): Promise<void> {
    await this.page.evaluate(
      ({ sel, seconds }) => {
        const player = document.querySelector(sel.player) as (Element & YouTubePlayerApi) | null;
        if (player && typeof player.seekTo === 'function') {
          player.seekTo(seconds, true);
          return;
        }
        const video = document.querySelector<HTMLVideoElement>(sel.video);
        if (!video) throw new Error('Nothing is playing.');
        video.currentTime = seconds;
      },
      { sel: SELECTORS, seconds: Math.max(0, seconds) },
    );
  }

  /** Waits until the player tab shows a video other than `previousId`. */
  async waitForVideoChange(previousId: string | null, timeoutMs = 15_000): Promise<PlayerState> {
    await this.page.waitForFunction(
      (prev) => {
        const id = new URL(location.href).searchParams.get('v');
        return id !== null && id !== prev;
      },
      previousId,
      { timeout: timeoutMs, polling: 250 },
    );
    return this.readState();
  }

  // ------------------------------------------------------------- internals

  async #goto(page: Page, url: string): Promise<void> {
    const navigate = () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.#opts.navigationTimeoutMs });
    try {
      await navigate();
    } catch (error) {
      // YouTube Music's own autoplay can fire a same-tab navigation at the exact moment we start ours.
      if (!/interrupted by another navigation|ERR_ABORTED/i.test(errorMessage(error))) throw error;
      this.#log.debug(`Navigation to ${url} was interrupted; retrying once.`);
      await navigate();
    }
    await this.#handleGate(page);
  }

  /**
   * If Google has put a CAPTCHA / consent / sign-in page up, hand it to the person at the keyboard
   * (in a visible window) or fail clearly. The bot never tries to solve or dodge these itself.
   */
  async #handleGate(page: Page): Promise<void> {
    const gate = detectGate(page.url());
    if (!gate) return;
    const reason = GATE_MESSAGES[gate];
    if (!this.#opts.interactive) {
      throw new GateError(gate, `${reason} Start the bot with a visible browser window and complete it there.`);
    }
    const minutes = Math.round(this.#opts.gateTimeoutMs / 60_000);
    this.#log.warn(`${reason} Please finish it in the browser window; waiting up to ${minutes} min.`);
    await page.bringToFront().catch(() => {});
    const baseHost = new URL(this.baseUrl).host;
    try {
      await page.waitForURL((u) => u.host === baseHost && detectGate(u.href) === null, {
        timeout: this.#opts.gateTimeoutMs,
        waitUntil: 'domcontentloaded',
      });
    } catch {
      throw new GateError(gate, `${reason} Timed out waiting for it to be completed in the browser window.`);
    }
    this.#log.info('Thanks, carrying on.');
  }

  async #waitForPlayback(videoId: string | null): Promise<void> {
    try {
      await this.page.waitForFunction(
        ({ id, videoSelector }) => {
          if (!document.querySelector(videoSelector)) return false;
          const current = new URL(location.href).searchParams.get('v');
          return id === null ? current !== null : current === id;
        },
        { id: videoId, videoSelector: SELECTORS.video },
        { timeout: this.#opts.navigationTimeoutMs, polling: 250 },
      );
    } catch (error) {
      await this.#handleGate(this.page);
      throw new Error(`YouTube Music didn't load ${videoId ? `video ${videoId}` : 'the playlist'}: ${errorMessage(error)}`);
    }

    // Autoplay normally kicks in by itself; if it hasn't after a few seconds, press play.
    // "Started" means the media is actually advancing (an ad counts), not just un-paused:
    // a <video> with nothing playable reports paused === false as soon as play() is called.
    if (await this.#waitForProgress(5_000)) return;
    await this.resume().catch(() => {});
    if (await this.#waitForProgress(8_000)) return;
    await this.#handleGate(this.page);
    throw new Error(
      `Playback of ${videoId ? `video ${videoId}` : 'the playlist'} didn't start. It may be unavailable in your region, removed, or need you to sign in.`,
    );
  }

  async #waitForProgress(timeoutMs: number): Promise<boolean> {
    return this.page
      .waitForFunction(
        (selector) => {
          const video = document.querySelector<HTMLVideoElement>(selector);
          return !!video && !video.paused && video.currentTime > 0;
        },
        SELECTORS.video,
        { timeout: timeoutMs, polling: 250 },
      )
      .then(() => true, () => false);
  }

  async #setPlaying(want: boolean): Promise<void> {
    if ((await this.readState()).isPlaying === want) return;
    if ((await this.#click(SELECTORS.playPauseButton)) && (await this.#waitForPlaying(want))) return;

    // The button didn't do it; talk to the <video> element directly.
    await this.page.evaluate(
      ({ selector, want }) => {
        const video = document.querySelector<HTMLVideoElement>(selector);
        if (!video) throw new Error('Nothing is loaded in the player yet.');
        if (want) void video.play().catch(() => {});
        else video.pause();
      },
      { selector: SELECTORS.video, want },
    );
    if (!(await this.#waitForPlaying(want))) {
      throw new Error(want ? "Playback didn't start." : "Playback didn't pause.");
    }
  }

  async #waitForPlaying(want: boolean, timeoutMs = 2_500): Promise<boolean> {
    return this.page
      .waitForFunction(
        ({ selector, want }) => {
          const video = document.querySelector<HTMLVideoElement>(selector);
          return !!video && !video.paused === want;
        },
        { selector: SELECTORS.video, want },
        { timeout: timeoutMs, polling: 100 },
      )
      .then(() => true, () => false);
  }

  async #click(selector: string): Promise<boolean> {
    const target = this.page.locator(selector).first();
    if ((await target.count()) === 0) return false;
    try {
      await target.click({ timeout: 2_000 });
      return true;
    } catch (error) {
      this.#log.debug(`Couldn't click ${selector}: ${errorMessage(error)}`);
      return false;
    }
  }

  async #callPlayer(method: 'nextVideo' | 'previousVideo'): Promise<void> {
    const ok = await this.page.evaluate(
      ({ selector, method }) => {
        const player = document.querySelector(selector) as (Element & YouTubePlayerApi) | null;
        const fn = player?.[method];
        if (typeof fn !== 'function') return false;
        fn.call(player);
        return true;
      },
      { selector: SELECTORS.player, method },
    );
    if (!ok) throw new Error('The player controls are not available; is anything playing?');
  }
}

// ------------------------------------------------------------------------------------------------
// Functions below run inside the browser via page.evaluate. They must be self-contained.

function readPlayerState(sel: Selectors): PlayerState {
  const video = document.querySelector<HTMLVideoElement>(sel.video);
  const player = document.querySelector(sel.player) as (Element & YouTubePlayerApi) | null;
  const metadata = navigator.mediaSession?.metadata ?? null;
  const text = (selector: string) => (document.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();

  let videoId: string | null = null;
  try {
    videoId = new URL(location.href).searchParams.get('v');
  } catch {
    // keep null
  }
  if (!videoId && typeof player?.getVideoData === 'function') {
    try {
      videoId = player.getVideoData()?.video_id || null;
    } catch {
      // keep null
    }
  }

  let volume = video ? Math.round(video.volume * 100) : 0;
  if (typeof player?.getVolume === 'function') {
    try {
      const v = player.getVolume();
      if (typeof v === 'number' && Number.isFinite(v)) volume = Math.round(v);
    } catch {
      // keep the <video> value
    }
  }

  const artwork = metadata?.artwork ?? [];
  return {
    url: location.href,
    videoId,
    title: metadata?.title || text(sel.playerBarTitle),
    artist: metadata?.artist || (text(sel.playerBarByline).split('•')[0] ?? '').trim(),
    album: metadata?.album || '',
    artwork: artwork[artwork.length - 1]?.src || document.querySelector<HTMLImageElement>(sel.playerBarImage)?.src || '',
    // readyState 0 means there is nothing to play, even if play() was called.
    isPlaying: !!video && !video.paused && !video.ended && video.readyState > 0,
    isAd: !!player && sel.adClasses.some((c) => player.classList.contains(c)),
    position: video?.currentTime ?? 0,
    duration: video && Number.isFinite(video.duration) ? video.duration : 0,
    volume,
    muted: !!video?.muted,
  };
}

function extractSearchResults(sel: Selectors): RawResult[] {
  const results: RawResult[] = [];
  const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
  const ids = (href: string | null) => {
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      const videoId = url.searchParams.get('v');
      return videoId ? { videoId, playlistId: url.searchParams.get('list') } : null;
    } catch {
      return null;
    }
  };

  // "Top result" card
  const card = document.querySelector(sel.topResultCard);
  const cardLink = card?.querySelector(sel.watchLink);
  const cardIds = ids(cardLink?.getAttribute('href') ?? null);
  if (card && cardLink && cardIds) {
    results.push({
      ...cardIds,
      title: clean(card.querySelector(sel.topResultTitle)?.textContent || cardLink.textContent),
      subtitle: clean(card.querySelector(sel.topResultSubtitle)?.textContent),
      thumbnail: card.querySelector('img')?.getAttribute('src') ?? '',
    });
  }

  // Result shelves. Song rows sometimes have no link on the title, but the element's
  // data model still carries the video ID.
  for (const item of document.querySelectorAll(sel.resultItem)) {
    const titleLink = item.querySelector(`${sel.resultTitle} a`) ?? item.querySelector(sel.watchLink);
    type WithData = { data?: { playlistItemData?: { videoId?: string } } };
    const modelId = (item as unknown as WithData).data?.playlistItemData?.videoId;
    const itemIds = ids(titleLink?.getAttribute('href') ?? null) ?? (modelId ? { videoId: modelId, playlistId: null } : null);
    if (!itemIds) continue; // artists, albums, profiles... not directly playable
    results.push({
      ...itemIds,
      title: clean(item.querySelector(sel.resultTitle)?.textContent),
      subtitle: clean(item.querySelector(sel.resultSubtitle)?.textContent),
      thumbnail: item.querySelector('img')?.getAttribute('src') ?? '',
    });
  }
  return results;
}

/**
 * The same video often shows up twice (as the top result and again in a shelf). Keep the first
 * position but merge in whatever the other copy knows, e.g. the album from the song row.
 */
function toTracks(raw: RawResult[]): Track[] {
  const byId = new Map<string, Track>();
  for (const r of raw) {
    if (!r.videoId) continue;
    const info = parseSubtitle(r.subtitle);
    const track = byId.get(r.videoId) ?? { videoId: r.videoId, title: '', artist: '', source: 'search' as const };
    track.title ||= r.title;
    track.artist ||= info.artist;
    if (info.kind && (!track.kind || info.kind === 'Song')) track.kind = info.kind;
    if (info.album && !track.album) track.album = info.album;
    if (info.durationSeconds !== undefined && track.durationSeconds === undefined) track.durationSeconds = info.durationSeconds;
    if (r.thumbnail && !r.thumbnail.startsWith('data:') && !track.thumbnail) track.thumbnail = r.thumbnail;
    if (r.playlistId && !track.playlistId) track.playlistId = r.playlistId;
    byId.set(r.videoId, track);
  }
  return [...byId.values()].map((t) => ({ ...t, title: t.title || t.videoId }));
}

/** Prefers an actual song (official audio) over user uploads and videos, otherwise YouTube's top pick. */
export function pickBestResult(results: Track[]): Track | undefined {
  return results.find((t) => t.kind === 'Song') ?? results[0];
}
