/** Where a track in the bot came from. */
export type TrackSource =
  /** Picked from search results. */
  | 'search'
  /** Given directly as a URL or video ID. */
  | 'url'
  /** Chosen by YouTube Music's own autoplay / "Up next". */
  | 'autoplay'
  /** Started by someone clicking around in the browser window. */
  | 'browser';

export interface Track {
  /** 11-character YouTube video ID. Empty only for a playlist that hasn't started yet. */
  videoId: string;
  title: string;
  artist: string;
  album?: string;
  durationSeconds?: number;
  thumbnail?: string;
  /** Set when the track should be played in the context of a playlist. */
  playlistId?: string;
  /** Result type as YouTube Music labels it: "Song", "Video", "Episode", ... */
  kind?: string;
  source: TrackSource;
}

/** A snapshot of what the YouTube Music player tab is doing right now. */
export interface PlayerState {
  url: string;
  videoId: string | null;
  title: string;
  artist: string;
  album: string;
  artwork: string;
  isPlaying: boolean;
  /** True while YouTube Music is playing an ad instead of the track. */
  isAd: boolean;
  /** Seconds into the current media. */
  position: number;
  /** Length of the current media in seconds, 0 if unknown. */
  duration: number;
  /** 0-100. */
  volume: number;
  muted: boolean;
}

/** Payload sent from the in-page `ended` listener back to Node. */
export interface MediaEndedEvent {
  videoId: string | null;
  isAd: boolean;
  duration: number;
}
