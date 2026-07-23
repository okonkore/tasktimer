import {
  ChatRepository,
  type Member,
  type ReadPosition,
  type Room,
} from "./data.ts";
import {
  ChatSessionService,
  requireChatAuthentication,
  requireChatMutation,
} from "./session.ts";

const roomIdPart = "([A-Za-z0-9_-]{16,64})";
const readPositionPattern = new RegExp(
  `^/api/chat/rooms/${roomIdPart}/read-position$`,
);
const messageIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const maxRequestBytes = 4 * 1024;

export interface ChatNotificationServiceOptions {
  repository: ChatRepository;
  sessions: ChatSessionService;
  now?: () => Date;
}

export class ChatNotificationService {
  readonly #repository: ChatRepository;
  readonly #sessions: ChatSessionService;
  readonly #now: () => Date;

  constructor(options: ChatNotificationServiceOptions) {
    this.#repository = options.repository;
    this.#sessions = options.sessions;
    this.#now = options.now ?? (() => new Date());
  }

  handler(): (request: Request) => Promise<Response> {
    return (request) => this.handle(request);
  }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/chat/notifications") {
      if (request.method !== "GET") {
        return notificationJson({ error: "Method not allowed" }, 405, {
          Allow: "GET",
        });
      }
      const authenticated = await requireChatAuthentication(
        request,
        this.#sessions,
      );
      if (authenticated instanceof Response) return authenticated;
      return notificationJson(await this.#summary(authenticated.user.id));
    }

    const match = path.match(readPositionPattern);
    if (!match) return notificationJson({ error: "Not found" }, 404);
    if (request.method !== "POST") {
      return notificationJson({ error: "Method not allowed" }, 405, {
        Allow: "POST",
      });
    }
    const authenticated = await requireChatMutation(request, this.#sessions);
    if (authenticated instanceof Response) return authenticated;
    const messageId = await messageIdFromRequest(request);
    if (messageId instanceof Response) return messageId;
    return await this.#advanceReadPosition(
      match[1],
      authenticated.user.id,
      messageId,
    );
  }

  async #summary(userId: string): Promise<ResponseBody> {
    const roomIds = new Set(await this.#repository.listRoomIdsByMember(userId));
    const rooms = (await Promise.all([...roomIds].map(async (roomId) => {
      const [room, member, position] = await Promise.all([
        this.#repository.getRoom(roomId),
        this.#repository.getMember(roomId, userId),
        this.#repository.getReadPosition(roomId, userId),
      ]);
      if (!room || !member) return null;
      const [unreadCount, pendingRequestCount] = await Promise.all([
        this.#repository.countUnreadMessages(
          roomId,
          userId,
          member.visibleFrom,
          position?.lastReadMessageId ?? null,
        ),
        room.ownerId === userId
          ? this.#repository.listJoinRequests(roomId, "pending").then((items) =>
            items.length
          )
          : Promise.resolve(0),
      ]);
      return roomNotificationSummary(
        room,
        member,
        unreadCount,
        pendingRequestCount,
      );
    }))).filter((room) => room !== null);
    const totalUnreadCount = rooms.reduce(
      (total, room) => total + room.unreadCount,
      0,
    );
    const totalPendingRequestCount = rooms.reduce(
      (total, room) => total + room.pendingRequestCount,
      0,
    );
    return { rooms, totalUnreadCount, totalPendingRequestCount };
  }

  async #advanceReadPosition(
    roomId: string,
    userId: string,
    messageId: string,
  ): Promise<Response> {
    const [room, member, message] = await Promise.all([
      this.#repository.getRoom(roomId),
      this.#repository.getMember(roomId, userId),
      this.#repository.getMessage(roomId, messageId),
    ]);
    if (!room) return notificationJson({ error: "Room not found" }, 404);
    if (!member) {
      return notificationJson({ error: "Room membership required" }, 403);
    }
    if (!message || message.createdAt < member.visibleFrom) {
      // Do not let a member use a message ID from an earlier membership to
      // infer or alter the read state of this room.
      return notificationJson({ error: "Message not found" }, 404);
    }
    const position: ReadPosition = {
      roomId,
      userId,
      lastReadMessageId: messageId,
      updatedAt: this.#now().toISOString(),
    };
    const saved = await this.#repository.advanceReadPosition(position);
    return notificationJson({ readPosition: publicReadPosition(saved) });
  }
}

export function createChatNotificationHandler(
  service: ChatNotificationService,
): (request: Request) => Promise<Response> {
  return service.handler();
}

interface RoomSummary {
  roomId: string;
  unreadCount: number;
  pendingRequestCount: number;
}

interface ResponseBody {
  rooms: RoomSummary[];
  totalUnreadCount: number;
  totalPendingRequestCount: number;
}

function roomNotificationSummary(
  room: Room,
  member: Member,
  unreadCount: number,
  pendingRequestCount: number,
): RoomSummary {
  return {
    roomId: room.id,
    unreadCount,
    // Pending request counts are only derived for the current owner. The
    // member argument also makes this boundary explicit for future changes.
    pendingRequestCount: member.role === "owner" ? pendingRequestCount : 0,
  };
}

function publicReadPosition(position: ReadPosition) {
  return {
    roomId: position.roomId,
    lastReadMessageId: position.lastReadMessageId,
    updatedAt: position.updatedAt,
  };
}

async function messageIdFromRequest(
  request: Request,
): Promise<string | Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxRequestBytes) {
    return notificationJson({ error: "Request body is too large" }, 413);
  }
  let value: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxRequestBytes) {
      return notificationJson({ error: "Request body is too large" }, 413);
    }
    value = JSON.parse(text);
  } catch {
    return notificationJson({ error: "Invalid JSON" }, 400);
  }
  if (!value || typeof value !== "object") {
    return notificationJson({ error: "A message ID is required" }, 400);
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.messageId !== "string" ||
    !messageIdPattern.test(candidate.messageId) ||
    Object.keys(candidate).some((key) => key !== "messageId")
  ) {
    return notificationJson({ error: "A valid message ID is required" }, 400);
  }
  return candidate.messageId;
}

function notificationJson(
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
