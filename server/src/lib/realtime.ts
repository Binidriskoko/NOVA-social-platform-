export type RealtimeEvent =
  | 'message:new'
  | 'message:read'
  | 'typing:start'
  | 'typing:stop'
  | 'presence:change'
  | 'notification:new'
  | 'notification:read'
  | 'call:update'
  | 'call:signal'
  | 'live:update'
  | 'live:signal';

export type RealtimeListener<T = unknown> = (payload: T) => void | Promise<void>;

class LocalRealtimeHub {
  private listeners = new Map<RealtimeEvent, Set<RealtimeListener<unknown>>>();

  subscribe<T>(event: RealtimeEvent, listener: RealtimeListener<T>) {
    const bucket = this.listeners.get(event) ?? new Set<RealtimeListener<unknown>>();
    bucket.add(listener as RealtimeListener<unknown>);
    this.listeners.set(event, bucket);

    return () => {
      bucket.delete(listener as RealtimeListener<unknown>);
      if (bucket.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  emit<T>(event: RealtimeEvent, payload: T) {
    const listeners = this.listeners.get(event);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      void listener(payload);
    }
  }
}

export const realtimeHub = new LocalRealtimeHub();

export function subscribeToUserEvents(userId: string, listener: RealtimeListener) {
  const events: RealtimeEvent[] = ['message:new', 'message:read', 'typing:start', 'typing:stop', 'presence:change', 'notification:new', 'notification:read', 'call:update', 'call:signal', 'live:update', 'live:signal'];
  const unsubscribers = events.map((event) => realtimeHub.subscribe(event, (payload) => {
    if (typeof payload === 'object' && payload !== null && 'allowedUserIds' in payload) {
      const allowedUserIds = (payload as { allowedUserIds?: unknown }).allowedUserIds;
      if (Array.isArray(allowedUserIds) && allowedUserIds.includes(userId)) {
        return listener({ event, ...(payload as Record<string, unknown>) });
      }
    }
  }));

  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

export function emitConversationEvent(
  event: RealtimeEvent,
  conversationId: string,
  payload: Record<string, unknown>,
  allowedUserIds: string[] = [],
) {
  realtimeHub.emit(event, {
    conversationId,
    allowedUserIds,
    ...payload,
  });
}
