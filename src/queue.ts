import type { Track } from './ytmusic/types.ts';

/** The bot's own "up next" list. Indexes in the public API are 1-based, as shown to users. */
export class TrackQueue {
  #items: Track[] = [];

  get length(): number {
    return this.#items.length;
  }

  list(): Track[] {
    return [...this.#items];
  }

  push(...tracks: Track[]): number {
    return this.#items.push(...tracks);
  }

  /** Put a track at the front so it plays next. */
  unshift(track: Track): void {
    this.#items.unshift(track);
  }

  shift(): Track | undefined {
    return this.#items.shift();
  }

  remove(position: number): Track {
    this.#assertPosition(position);
    return this.#items.splice(position - 1, 1)[0]!;
  }

  move(from: number, to: number): void {
    this.#assertPosition(from);
    this.#assertPosition(to);
    const [track] = this.#items.splice(from - 1, 1);
    this.#items.splice(to - 1, 0, track!);
  }

  clear(): number {
    const count = this.#items.length;
    this.#items = [];
    return count;
  }

  #assertPosition(position: number): void {
    if (!Number.isInteger(position) || position < 1 || position > this.#items.length) {
      throw new Error(
        this.#items.length === 0
          ? 'The queue is empty.'
          : `No track at position ${position}; the queue has ${this.#items.length}.`,
      );
    }
  }
}

/** Runs async jobs one at a time, in the order they were submitted. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  get busy(): boolean {
    return this.#pending > 0;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.#pending++;
    const result = this.#tail.then(job);
    this.#tail = result.then(
      () => this.#pending--,
      () => this.#pending--,
    );
    return result;
  }
}
