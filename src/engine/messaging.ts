/**
 * Messaging (SPEC §5.2 phase 4, §5.4): the traffic-category registry and the delivery-round
 * message bus.
 *
 * Rounds: messages sent before delivery (preTick/emit) carry `round: 0` and are delivered in
 * round 1; a message sent from `onMessage` in round k carries `round: k` and is delivered in
 * round k+1, up to N rounds (default 3: request → response → follow-up). Messages sent in the
 * last round, or in tick/postTick/actions, wait for round 1 of the next tick.
 */
import type { Message, MessageDraft, MsgKind, SimTime, TrafficCategory } from './types';

export const DEFAULT_DELIVERY_ROUNDS = 3;

/** Maps message kinds to the traffic categories the UI colors by. Domain modules register. */
export class TrafficRegistry {
  private readonly map = new Map<MsgKind, TrafficCategory>();

  constructor(initial: Readonly<Record<MsgKind, TrafficCategory>> = {}) {
    for (const [k, c] of Object.entries(initial)) this.register(k, c);
  }

  /** Register `kind`; re-registering with a different category is an error. */
  register(kind: MsgKind, category: TrafficCategory): this {
    const prev = this.map.get(kind);
    if (prev !== undefined && prev !== category) {
      throw new Error(`message kind '${kind}' already registered as '${prev}'`);
    }
    this.map.set(kind, category);
    return this;
  }

  /** Category of `kind`; unregistered kinds fall back to the kind itself. */
  categoryOf(kind: MsgKind): TrafficCategory {
    return this.map.get(kind) ?? kind;
  }

  entries(): readonly (readonly [MsgKind, TrafficCategory])[] {
    return [...this.map.entries()];
  }
}

export class MessageBus {
  private seq = 0;
  private queue: Message[] = [];
  /** Round stamped on messages sent now (0 outside delivery rounds). */
  private sendRound = 0;

  get pendingCount(): number {
    return this.queue.length;
  }

  send<P>(draft: MessageDraft<P>, now: SimTime): Message<P> {
    const msg: Message<P> = Object.freeze({
      ...draft,
      id: `m${++this.seq}`,
      sentAt: now,
      round: this.sendRound,
    });
    this.queue.push(msg);
    return msg;
  }

  /**
   * Run delivery rounds 1..`rounds`. Each round delivers what was queued before it, in send
   * order; anything sent while handling round k is delivered in round k+1. Messages sent in the
   * final round stay queued for the next tick.
   */
  deliverRounds(rounds: number, deliver: (msg: Message, round: number) => void): void {
    for (let r = 1; r <= rounds && this.queue.length > 0; r++) {
      const batch = this.queue;
      this.queue = [];
      this.sendRound = r;
      for (const msg of batch) deliver(msg, r);
    }
    this.sendRound = 0;
  }
}
