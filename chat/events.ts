import {
  type ChatEvent,
  chatLimits,
  ChatRepository,
  type Member,
  type Room,
} from "./data.ts";
import { ChatSessionService, requireChatAuthentication } from "./session.ts";

const eventIdPattern = /^[0-9]{20}$/;
const encoder = new TextEncoder();

type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export interface ChatEventServiceOptions {
  repository: ChatRepository;
  sessions: ChatSessionService;
  pollIntervalMilliseconds?: number;
  heartbeatIntervalMilliseconds?: number;
  wait?: Wait;
  now?: () => Date;
}

export class ChatEventService {
  readonly #repository: ChatRepository;
  readonly #sessions: ChatSessionService;
  readonly #pollIntervalMilliseconds: number;
  readonly #heartbeatIntervalMilliseconds: number;
  readonly #wait: Wait;
  readonly #now: () => Date;

  constructor(options: ChatEventServiceOptions) {
    this.#repository = options.repository;
    this.#sessions = options.sessions;
    this.#pollIntervalMilliseconds = Math.max(
      10,
      options.pollIntervalMilliseconds ?? 1_000,
    );
    this.#heartbeatIntervalMilliseconds = Math.max(
      this.#pollIntervalMilliseconds,
      options.heartbeatIntervalMilliseconds ?? 15_000,
    );
    this.#wait = options.wait ?? abortableWait;
    this.#now = options.now ?? (() => new Date());
  }

  handler(): (request: Request) => Promise<Response> {
    return (request) => this.handle(request);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/chat/events") {
      return eventJson({ error: "Not found" }, 404);
    }
    if (request.method !== "GET") {
      return eventJson({ error: "Method not allowed" }, 405, {
        Allow: "GET",
      });
    }
    if ([...url.searchParams].length > 0) {
      return eventJson({ error: "Unsupported query parameter" }, 400);
    }

    const lastEventId = request.headers.get("last-event-id") ?? "";
    if (lastEventId && !eventIdPattern.test(lastEventId)) {
      return eventJson({ error: "Invalid event cursor" }, 400);
    }
    const authenticated = await requireChatAuthentication(
      request,
      this.#sessions,
    );
    if (authenticated instanceof Response) return authenticated;

    const abortController = new AbortController();
    const stop = () => abortController.abort();
    request.signal.addEventListener("abort", stop, { once: true });
    // A fresh connection starts at the current high-water mark. Historical
    // replay is reserved for reconnects that provide Last-Event-ID.
    let cursor = lastEventId || await this.#repository.getLatestEventId();
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(encoder.encode("retry: 2000\n\n"));
        void this.#pump(
          request,
          authenticated.user.id,
          cursor,
          abortController.signal,
          (nextCursor) => {
            cursor = nextCursor;
          },
          (chunk) => {
            if (!cancelled) controller.enqueue(encoder.encode(chunk));
          },
        ).then(() => {
          if (!cancelled) controller.close();
        }).catch((error) => {
          if (!cancelled && !abortController.signal.aborted) {
            console.error("Chat event stream failed", error);
            controller.error(error);
          }
        }).finally(() => {
          request.signal.removeEventListener("abort", stop);
        });
      },
      cancel: () => {
        cancelled = true;
        abortController.abort();
        request.signal.removeEventListener("abort", stop);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async #pump(
    request: Request,
    expectedUserId: string,
    initialCursor: string,
    signal: AbortSignal,
    updateCursor: (eventId: string) => void,
    emit: (chunk: string) => void,
  ): Promise<void> {
    let cursor = initialCursor;
    let lastHeartbeat = this.#now().getTime();
    while (!signal.aborted) {
      // Re-authentication on every poll closes logged-out/expired sessions
      // promptly, without relying on process-local connection state.
      const authenticated = await this.#sessions.authenticate(request);
      if (!authenticated || authenticated.user.id !== expectedUserId) return;

      let pageWasFull = false;
      do {
        const events = await this.#repository.listEventsAfter(
          cursor,
          chatLimits.maxPageSize,
        );
        pageWasFull = events.length === chatLimits.maxPageSize;
        for (const event of events) {
          if (signal.aborted) return;
          // Advance over unauthorized events as well. If access is later
          // restored, a user must not receive events from the removed period.
          cursor = event.id;
          updateCursor(cursor);
          if (
            await this.#canDeliver(
              event,
              authenticated.user.id,
            )
          ) {
            emit(serializeEvent(event));
          }
        }
      } while (pageWasFull && !signal.aborted);

      const now = this.#now().getTime();
      if (now - lastHeartbeat >= this.#heartbeatIntervalMilliseconds) {
        emit(`: heartbeat ${new Date(now).toISOString()}\n\n`);
        lastHeartbeat = now;
      }
      await this.#wait(this.#pollIntervalMilliseconds, signal);
    }
  }

  async #canDeliver(event: ChatEvent, userId: string): Promise<boolean> {
    const room = await this.#repository.getRoom(event.roomId);
    if (!room) return false;

    if (event.audience === "room-owner") {
      if (room.ownerId !== userId || event.targetUserId !== userId) {
        return false;
      }
      const member = await this.#repository.getMember(event.roomId, userId);
      return member?.role === "owner";
    }

    if (event.audience === "room-members") {
      const member = await this.#repository.getMember(event.roomId, userId);
      return canReceiveRoomEvent(room, member, userId, event);
    }

    if (event.targetUserId !== userId) return false;
    if (
      event.type === "join-approved" ||
      event.type === "permission-changed"
    ) {
      return (await this.#repository.getMember(event.roomId, userId)) !== null;
    }
    return event.type === "join-rejected" || event.type === "member-removed";
  }
}

export function createChatEventHandler(
  service: ChatEventService,
): (request: Request) => Promise<Response> {
  return service.handler();
}

function canReceiveRoomEvent(
  room: Room,
  member: Member | null,
  userId: string,
  event: ChatEvent,
): boolean {
  if (!member || member.userId !== userId || room.id !== member.roomId) {
    return false;
  }
  return event.createdAt >= member.visibleFrom;
}

function serializeEvent(event: ChatEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${
    JSON.stringify(event)
  }\n\n`;
}

function abortableWait(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function eventJson(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}
