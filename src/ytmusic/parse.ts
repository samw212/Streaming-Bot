/**
 * Pure parsing helpers. Nothing in here touches the browser, so all of it is unit tested.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** What a user-supplied "thing to play" refers to. */
export type PlayTarget =
  | { kind: 'video'; videoId: string; playlistId?: string }
  | { kind: 'playlist'; playlistId: string }
  | { kind: 'searchRef'; index: number }
  | { kind: 'query'; query: string };

export function isVideoId(value: string): boolean {
  return VIDEO_ID.test(value);
}

/**
 * A bare 11-character string is only treated as a video ID when it doesn't look like a word,
 * so that searching for "underground" doesn't try to play video "underground".
 * Real IDs are random base64 and almost always contain a digit, '-', '_' or mixed case.
 */
export function looksLikeVideoId(value: string): boolean {
  if (!VIDEO_ID.test(value)) return false;
  return /[0-9_-]/.test(value) || (/[A-Z]/.test(value.slice(1)) && /[a-z]/.test(value));
}

/** Parses youtube.com, music.youtube.com and youtu.be links. Returns null for anything else. */
export function parseYouTubeUrl(input: string): PlayTarget | null {
  const value = input.trim();
  if (!value || /\s/.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const list = url.searchParams.get('list') ?? undefined;

  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? '';
    return isVideoId(id) ? withPlaylist(id, list) : null;
  }
  if (host !== 'youtube.com' && host !== 'music.youtube.com') return null;

  const v = url.searchParams.get('v');
  if (v && isVideoId(v)) return withPlaylist(v, list);

  const pathId = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(url.pathname)?.[1];
  if (pathId) return withPlaylist(pathId, list);

  if (list) return { kind: 'playlist', playlistId: list };
  return null;
}

function withPlaylist(videoId: string, playlistId: string | undefined): PlayTarget {
  return playlistId ? { kind: 'video', videoId, playlistId } : { kind: 'video', videoId };
}

/**
 * Interprets what the user typed after "play" / "add":
 *  - `#3`               the 3rd result of the last search
 *  - a YouTube URL      that video or playlist
 *  - `id:XXXXXXXXXXX`   an explicit video ID
 *  - a bare video ID    if it doesn't look like a normal word
 *  - anything else      a search query
 */
export function parseTarget(input: string): PlayTarget {
  const value = input.trim();
  if (!value) throw new Error('Nothing to play: give a search query, a YouTube Music URL, or #N from the last search.');

  const ref = /^#(\d+)$/.exec(value);
  if (ref) return { kind: 'searchRef', index: Number(ref[1]) };

  const fromUrl = parseYouTubeUrl(value);
  if (fromUrl) return fromUrl;

  if (value.toLowerCase().startsWith('id:')) {
    const id = value.slice(3).trim();
    if (!isVideoId(id)) throw new Error(`"${id}" is not a valid YouTube video ID (expected 11 characters).`);
    return { kind: 'video', videoId: id };
  }

  if (looksLikeVideoId(value)) return { kind: 'video', videoId: value };
  return { kind: 'query', query: value };
}

/** "3:45" -> 225, "1:02:03" -> 3723. Returns undefined if the text isn't a duration. */
export function parseDuration(text: string): number | undefined {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const [, h, m, s] = match;
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s);
}

/** 225 -> "3:45", 3723 -> "1:02:03". */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const t = Math.floor(totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Result types YouTube Music prints as the first segment of a search result's subtitle. */
const RESULT_KINDS = new Set([
  'Song', 'Video', 'Episode', 'Podcast', 'Album', 'Single', 'EP', 'Playlist', 'Artist', 'Profile', 'Station',
]);

export interface SubtitleInfo {
  kind?: string;
  artist: string;
  album?: string;
  durationSeconds?: number;
}

/**
 * Parses a search result subtitle such as
 *   "Song • Daft Punk • Random Access Memories • 6:09"
 *   "Video • Nile Rodgers, Pharrell & Daft Punk • 1.9M views"
 */
export function parseSubtitle(text: string): SubtitleInfo {
  const parts = text
    .split('•')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const info: SubtitleInfo = { artist: '' };
  if (parts[0] && RESULT_KINDS.has(parts[0])) info.kind = parts.shift();

  const rest: string[] = [];
  for (const part of parts) {
    const duration = parseDuration(part);
    if (duration !== undefined) {
      info.durationSeconds = duration;
    } else if (/\b(views?|plays?|listeners?|monthly audience|subscribers?)$/i.test(part) || /^\d{4}$/.test(part)) {
      // Popularity stats and release years aren't useful for playback.
    } else {
      rest.push(part);
    }
  }

  info.artist = rest[0] ?? '';
  if (rest[1] && (info.kind === undefined || info.kind === 'Song')) info.album = rest[1];
  return info;
}

/**
 * Parses a seek target relative to the current position:
 * "90" or "1:30" are absolute, "+10" / "-15" are relative.
 */
export function parseSeek(input: string, currentPosition: number): number {
  const value = input.trim();
  const relative = /^([+-])\s*(.+)$/.exec(value);
  const body = relative ? relative[2]! : value;
  const seconds = /^\d+(\.\d+)?$/.test(body) ? Number(body) : parseDuration(body);
  if (seconds === undefined || Number.isNaN(seconds)) {
    throw new Error(`Can't understand seek position "${input}". Use seconds (90), mm:ss (1:30), or +10 / -10.`);
  }
  if (!relative) return seconds;
  return Math.max(0, relative[1] === '+' ? currentPosition + seconds : currentPosition - seconds);
}
