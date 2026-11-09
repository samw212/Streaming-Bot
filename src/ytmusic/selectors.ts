/**
 * Every CSS selector and URL shape the bot depends on lives here, so that when YouTube Music
 * changes its markup there is exactly one file to update.
 *
 * Playback deliberately leans on web standards first (the <video> element and
 * navigator.mediaSession), then on the player bar buttons a person would click, and only
 * then on YouTube's player API, so a markup change rarely breaks everything at once.
 */
export const SELECTORS = {
  // Search results page
  resultItem: 'ytmusic-responsive-list-item-renderer',
  resultTitle: '.title-column .title',
  resultSubtitle: '.secondary-flex-columns',
  topResultCard: 'ytmusic-card-shelf-renderer',
  topResultTitle: '.details-container .title',
  topResultSubtitle: '.details-container .subtitle',
  /** The "No results found" message. */
  noResults: 'ytmusic-message-renderer',
  watchLink: 'a[href*="watch?v="]',

  // Player
  player: '#movie_player',
  video: '#movie_player video, video',
  playerBarTitle: 'ytmusic-player-bar .title',
  playerBarByline: 'ytmusic-player-bar .byline',
  playerBarImage: 'ytmusic-player-bar img',
  playPauseButton: 'ytmusic-player-bar #play-pause-button',
  nextButton: 'ytmusic-player-bar .next-button',
  previousButton: 'ytmusic-player-bar .previous-button',

  /** Classes the YouTube player puts on #movie_player while an ad is playing. */
  adClasses: ['ad-showing', 'ad-interrupting'],
} as const;

export type Selectors = typeof SELECTORS;

export const DEFAULT_BASE_URL = 'https://music.youtube.com';

export const urls = {
  home: (base: string) => `${base}/`,
  search: (base: string, query: string) => `${base}/search?q=${encodeURIComponent(query)}`,
  watch: (base: string, videoId: string, playlistId?: string) =>
    `${base}/watch?v=${encodeURIComponent(videoId)}${playlistId ? `&list=${encodeURIComponent(playlistId)}` : ''}`,
  playlist: (base: string, playlistId: string) => `${base}/watch?list=${encodeURIComponent(playlistId)}`,
};

/** Pages Google may put between the bot and YouTube Music. The bot never tries to get past them on its own. */
export type GateKind = 'captcha' | 'consent' | 'signin';

export const GATE_MESSAGES: Record<GateKind, string> = {
  captcha: "Google is showing an \"unusual traffic\" check for this network.",
  consent: 'YouTube is asking you to choose your cookie settings.',
  signin: 'Google is asking you to sign in.',
};

export function detectGate(url: string): GateKind | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.pathname.startsWith('/sorry/')) return 'captcha';
  if (/^consent\.(youtube|google)\./.test(parsed.hostname)) return 'consent';
  if (parsed.hostname === 'accounts.google.com') return 'signin';
  return null;
}
