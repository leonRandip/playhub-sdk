import { BOOST_PLACES, peekType } from '@playhub/protocol';
import type { Registry, Sock } from './registry.ts';

interface Entry {
  sock: Sock;
  hello: string;
  boosted: boolean;
}

export interface AdmissionOptions {
  registry: Registry;
  /** Players the hub serves at once (connected and said hello). Beyond it, newcomers wait in line. */
  maxActive: number;
  /** People that may wait. Beyond it a connection is refused outright (the client retries later). */
  maxQueue: number;
  now?: () => number;
}

/**
 * Keeps a small VM responsive: instead of slowing down for everybody, the hub serves `maxActive` players and puts the
 * rest in a first-come, first-served line, telling each their place. A player coming back to a seat held for them
 * (inside the grace period) skips the line; one boost per connection moves a waiting player up `BOOST_PLACES`.
 */
export class Admission {
  private queue: Entry[] = [];
  /** When the most recent admissions from the line happened (for the wait estimate). */
  private admittedAt: number[] = [];
  private readonly now: () => number;

  constructor(private readonly o: AdmissionOptions) {
    this.now = o.now ?? Date.now;
  }

  get size(): number {
    return this.queue.length;
  }

  has(sock: Sock): boolean {
    return this.queue.some((e) => e.sock === sock);
  }

  /** A hello arrived: let it through (`admit`), put it in line (`queued`) or refuse it (`full`). */
  offer(sock: Sock, hello: string): 'admit' | 'queued' | 'full' {
    if (this.queue.length === 0 && this.o.registry.playerCount < this.o.maxActive) return 'admit';
    if (this.returningWithSeat(hello)) return 'admit';
    if (this.queue.length >= this.o.maxQueue) return 'full';
    this.queue.push({ sock, hello, boosted: false });
    this.tell(this.queue.length - 1);
    return 'queued';
  }

  private returningWithSeat(hello: string): boolean {
    if (peekType(hello) !== 'lobbyHello') return false;
    try {
      const h = JSON.parse(hello) as { game?: string; player?: { id?: string } };
      return !!h.game && !!h.player?.id && this.o.registry.hasAwaySeat(h.game, h.player.id);
    } catch {
      return false;
    }
  }

  /** A waiting player used their boost (once). */
  boost(sock: Sock): void {
    const i = this.queue.findIndex((e) => e.sock === sock);
    if (i < 0 || this.queue[i]!.boosted) return;
    const [e] = this.queue.splice(i, 1);
    e!.boosted = true;
    const to = Math.max(0, i - BOOST_PLACES);
    this.queue.splice(to, 0, e!);
    this.tell(to);
  }

  /** The socket went away (or gave up waiting). */
  remove(sock: Sock): void {
    const i = this.queue.findIndex((e) => e.sock === sock);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /** Admits as many from the front as there is room for. Call when a slot may have freed. */
  pump(): void {
    while (this.queue.length && this.o.registry.playerCount < this.o.maxActive) {
      const e = this.queue.shift()!;
      this.admittedAt = [...this.admittedAt, this.now()].slice(-10);
      this.o.registry.onMessage(e.sock, e.hello); // the lobbyWelcome that follows is the player's "you are in"
    }
  }

  /** Seconds a place in line takes to clear, from how fast the last admissions came. */
  private secondsPerPlace(): number {
    const t = this.admittedAt;
    if (t.length < 2) return 15;
    const mean = (t[t.length - 1]! - t[0]!) / (t.length - 1) / 1000;
    return Math.min(120, Math.max(2, mean));
  }

  private tell(i: number): void {
    const e = this.queue[i];
    if (!e) return;
    try {
      e.sock.send(
        JSON.stringify({
          type: 'lobbyQueued',
          position: i + 1,
          size: this.queue.length,
          etaSeconds: Math.ceil((i + 1) * this.secondsPerPlace()),
          boosted: e.boosted,
        }),
      );
    } catch {
      /* a closing socket */
    }
  }

  /** Tells everyone in line where they stand. */
  notifyAll(): void {
    for (let i = 0; i < this.queue.length; i++) this.tell(i);
  }
}
