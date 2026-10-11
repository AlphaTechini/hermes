import type { StreamEvent } from "@hermes/shared";

export interface BusMessage {
  userId: string;
  event: StreamEvent;
}
export type BusListener = (msg: BusMessage) => void;

/** In-process pub/sub. The SSE endpoint subscribes per connection and filters by user. */
export class EventBus {
  private listeners = new Set<BusListener>();

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(userId: string, event: StreamEvent): void {
    for (const l of this.listeners) {
      try {
        l({ userId, event });
      } catch {
        // never let one subscriber break the pipeline
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
