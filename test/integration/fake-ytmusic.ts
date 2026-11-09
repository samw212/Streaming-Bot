/**
 * A tiny stand-in for music.youtube.com, for tests. It reproduces the parts of the real site the
 * bot relies on: the search result markup, a player bar, #movie_player with a <video>,
 * navigator.mediaSession metadata, SPA-style track changes via history.pushState, autoplay to a
 * "related" track when one ends, preroll ads, playlists, and Google's /sorry interstitial.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeTrack {
  title: string;
  artist: string;
  album?: string;
  seconds: number;
  /** What the fake's autoplay picks after this track. */
  related: string;
  /** Plays a 1s ad before the track. */
  ad?: boolean;
}

export const CATALOG: Record<string, FakeTrack> = {
  trackAAAA01: { title: 'Alpha Song', artist: 'The Testers', album: 'First Album', seconds: 2, related: 'trackRAD001' },
  trackBBBB02: { title: 'Bravo Song', artist: 'The Testers', album: 'First Album', seconds: 2, related: 'trackRAD001' },
  trackCCCC03: { title: 'Charlie Song', artist: 'Other Band', album: 'Second Album', seconds: 2, related: 'trackRAD001' },
  trackADS004: { title: 'Delta Song', artist: 'Other Band', album: 'Second Album', seconds: 2, related: 'trackRAD001', ad: true },
  trackRAD001: { title: 'Radio Pick One', artist: 'Radio', seconds: 30, related: 'trackRAD002' },
  trackRAD002: { title: 'Radio Pick Two', artist: 'Radio', seconds: 30, related: 'trackRAD001' },
};

export const PLAYLISTS: Record<string, string[]> = {
  PLtest00001: ['trackBBBB02', 'trackCCCC03'],
};

export interface FakeYTMusic {
  url: string;
  close(): Promise<void>;
}

export async function startFakeYTMusic(): Promise<FakeYTMusic> {
  const server = createServer((req, res) => route(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function route(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const media = /^\/media\/([\w-]+)\.wav$/.exec(url.pathname);

  if (media) {
    const id = media[1]!;
    const seconds = id === 'ad' ? 1 : CATALOG[id]?.seconds;
    if (!seconds) return send(res, 404, 'text/plain', 'no such media');
    // Byte ranges, as a real media server would: browsers need them to seek.
    const wav = silentWav(seconds);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, wav.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${wav.length}`, 'Content-Length': end - start + 1 });
      res.end(wav.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': wav.length });
    res.end(wav);
    return;
  }

  switch (url.pathname) {
    case '/':
      return send(res, 200, 'text/html', shell('<p>Home</p>'));
    case '/search': {
      const query = url.searchParams.get('q') ?? '';
      if (query === 'blocked' && !/solved=1/.test(req.headers.cookie ?? '')) {
        res.writeHead(302, { Location: `/sorry/index?continue=${encodeURIComponent(req.url ?? '/')}` });
        res.end();
        return;
      }
      return send(res, 200, 'text/html', shell(searchPage(query)));
    }
    case '/sorry/index':
      return send(res, 200, 'text/html', sorryPage(url.searchParams.get('continue') ?? '/'));
    case '/watch':
      return send(res, 200, 'text/html', shell(watchPage()));
    default:
      return send(res, 404, 'text/plain', 'not found');
  }
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
  res.end(body);
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function shell(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>YouTube Music</title></head><body><ytmusic-app>${body}</ytmusic-app></body></html>`;
}

function searchPage(query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = Object.entries(CATALOG).filter(([, t]) =>
    words.every((w) => `${t.title} ${t.artist}`.toLowerCase().includes(w)),
  );
  if (matches.length === 0) return '<ytmusic-message-renderer>No results</ytmusic-message-renderer>';

  const [topId, top] = matches[0]!;
  const card = `
    <ytmusic-card-shelf-renderer>
      <div class="details-container">
        <yt-formatted-string class="title"><a href="watch?v=${topId}">${escape(top.title)}</a></yt-formatted-string>
        <yt-formatted-string class="subtitle">Video • ${escape(top.artist)} • 1.2M views • ${mmss(top.seconds)}</yt-formatted-string>
      </div>
    </ytmusic-card-shelf-renderer>`;
  const artistRow = `
    <ytmusic-responsive-list-item-renderer>
      <div class="flex-columns"><div class="title-column"><yt-formatted-string class="title">${escape(top.artist)}</yt-formatted-string></div>
      <div class="secondary-flex-columns"><yt-formatted-string class="flex-column">Artist • 2M monthly audience</yt-formatted-string></div></div>
      <a href="channel/UCfake">channel</a>
    </ytmusic-responsive-list-item-renderer>`;
  const songRows = matches
    .map(
      ([id, t]) => `
    <ytmusic-responsive-list-item-renderer>
      <div class="left-items"><img src="https://example.invalid/thumb/${id}.jpg"></div>
      <div class="flex-columns">
        <div class="title-column"><yt-formatted-string class="title"><a href="watch?v=${id}">${escape(t.title)}</a></yt-formatted-string></div>
        <div class="secondary-flex-columns">
          <yt-formatted-string class="flex-column">Song</yt-formatted-string>
          <yt-formatted-string class="flex-column"> • ${escape(t.artist)}${t.album ? ` • ${escape(t.album)}` : ''} • ${mmss(t.seconds)}</yt-formatted-string>
        </div>
      </div>
    </ytmusic-responsive-list-item-renderer>`,
    )
    .join('');
  return `${card}<ytmusic-shelf-renderer>${artistRow}${songRows}</ytmusic-shelf-renderer>`;
}

function sorryPage(next: string): string {
  return `<!doctype html><html><body>
    <p>Our systems have detected unusual traffic from your computer network.</p>
    <button id="solve" onclick="document.cookie='solved=1; path=/'; location.href=${escape(JSON.stringify(next))}">I'm not a robot</button>
  </body></html>`;
}

function watchPage(): string {
  return `
    <ytmusic-player><div id="movie_player" class="html5-video-player"><video class="html5-main-video"></video></div></ytmusic-player>
    <ytmusic-player-bar>
      <img class="image" src="">
      <div class="title"></div><div class="byline"></div>
      <button class="previous-button" aria-label="Previous">Prev</button>
      <button id="play-pause-button" aria-label="Play">Play</button>
      <button class="next-button" aria-label="Next">Next</button>
    </ytmusic-player-bar>
    <script>
      const CATALOG = ${JSON.stringify(CATALOG)};
      const PLAYLISTS = ${JSON.stringify(PLAYLISTS)};
      const video = document.querySelector('video');
      const player = document.getElementById('movie_player');
      const playButton = document.getElementById('play-pause-button');
      const params = new URLSearchParams(location.search);
      const list = params.get('list');
      let current = null;
      const adsPlayed = new Set();

      function nextId() {
        const ids = list && PLAYLISTS[list];
        if (ids && ids.includes(current)) return ids[(ids.indexOf(current) + 1) % ids.length];
        return CATALOG[current].related;
      }

      function load(id, push) {
        current = id;
        const t = CATALOG[id];
        const url = '/watch?v=' + id + (list ? '&list=' + list : '');
        if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
        document.querySelector('ytmusic-player-bar .title').textContent = t.title;
        document.querySelector('ytmusic-player-bar .byline').textContent = t.artist + (t.album ? ' • ' + t.album : '') + ' • 2024';
        navigator.mediaSession.metadata = new MediaMetadata({
          title: t.title, artist: t.artist, album: t.album || '',
          artwork: [{ src: 'https://example.invalid/art/' + id + '.jpg', sizes: '544x544' }],
        });
        if (t.ad && !adsPlayed.has(id)) {
          adsPlayed.add(id);
          player.classList.add('ad-showing');
          video.src = '/media/ad.wav';
        } else {
          player.classList.remove('ad-showing');
          video.src = '/media/' + id + '.wav';
        }
        video.play().catch(() => {});
      }

      video.addEventListener('ended', () => {
        if (player.classList.contains('ad-showing')) {
          player.classList.remove('ad-showing');
          video.src = '/media/' + current + '.wav';
          video.play().catch(() => {});
          return;
        }
        // Like YouTube Music: move on to something else shortly after a track ends.
        setTimeout(() => load(nextId(), true), 150);
      });
      video.addEventListener('play', () => playButton.setAttribute('aria-label', 'Pause'));
      video.addEventListener('pause', () => playButton.setAttribute('aria-label', 'Play'));
      playButton.addEventListener('click', () => (video.paused ? video.play() : video.pause()));
      document.querySelector('.next-button').addEventListener('click', () => load(nextId(), true));
      document.querySelector('.previous-button').addEventListener('click', () => { video.currentTime = 0; });

      const start = params.get('v') || (list && PLAYLISTS[list] && PLAYLISTS[list][0]);
      if (start && CATALOG[start]) load(start, false);
    </script>`;
}

/** Mono 16-bit 8 kHz silence. */
function silentWav(seconds: number): Buffer {
  const sampleRate = 8000;
  const dataSize = seconds * sampleRate * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
