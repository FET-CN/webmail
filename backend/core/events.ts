import type { Event } from "../contract/api.ts";

export interface EventHub {
  subscribe(listener: (event: Event) => void): () => void;
  publish(event: Event): void;
}

export class MemoryEventHub implements EventHub {
  private readonly listeners = new Set<(event: Event) => void>();

  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: Event): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function event(type: string, data: Record<string, unknown>): Event {
  return {
    object: "event",
    id: `evt_${crypto.randomUUID().replaceAll("-", "")}`,
    type,
    created_at: new Date().toISOString(),
    data,
  };
}
