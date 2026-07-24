import {
  type ChatEventDraft,
  chatLimits,
  ChatRepository,
  createSortableId,
  type Message,
} from "./data.ts";
import {
  ChatSessionService,
  requireChatAuthentication,
  requireChatMutation,
} from "./session.ts";

const maxMessageRequestBytes = 16 * 1024;
const roomIdPart = "([A-Za-z0-9_-]{16,64})";
const messageIdPart = "([0-9A-HJKMNP-TV-Z]{26})";
const messageCollectionPattern = new RegExp(
  `^/api/chat/rooms/${roomIdPart}/messages$`,
);
const messageItemPattern = new RegExp(
  `^/api/chat/rooms/${roomIdPart}/messages/${messageIdPart}$`,
);

type Clock = () => Date;
type MessageIdGenerator = (date: Date) => string;

export interface MessageServiceOptions {
  repository: ChatRepository;
  sessions: ChatSessionService;
  now?: Clock;
  generateMessageId?: MessageIdGenerator;
}

export class ChatMessageService {
  readonly #repository: ChatRepository;
  readonly #sessions: ChatSessionService;
  readonly #now: Clock;
  readonly #generateMessageId: MessageIdGenerator;

  constructor(options: MessageServiceOptions) {
    this.#repository = options.repository;
    this.#sessions = options.sessions;
    this.#now = options.now ?? (() => new Date());
    this.#generateMessageId = options.generateMessageId ?? createSortableId;
  }

  handler(): (request: Request) => Promise<Response> {
    return (request) => this.handle(request);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const collectionMatch = url.pathname.match(messageCollectionPattern);
    if (collectionMatch) {
      const roomId = collectionMatch[1];
      if (request.method === "GET") {
        const authenticated = await requireChatAuthentication(
          request,
          this.#sessions,
        );
        if (authenticated instanceof Response) return authenticated;
        return await this.#list(
          roomId,
          authenticated.user.id,
          url.searchParams,
        );
      }
      if (request.method === "POST") {
        const authenticated = await requireChatMutation(
          request,
          this.#sessions,
        );
        if (authenticated instanceof Response) return authenticated;
        const body = await messageBodyFromRequest(request);
        if (body instanceof Response) return body;
        return await this.#create(roomId, authenticated.user.id, body);
      }
      return messageJson({ error: "Method not allowed" }, 405, {
        Allow: "GET, POST",
      });
    }

    const itemMatch = url.pathname.match(messageItemPattern);
    if (!itemMatch) return messageJson({ error: "Not found" }, 404);
    if (request.method !== "DELETE") {
      return messageJson({ error: "Method not allowed" }, 405, {
        Allow: "DELETE",
      });
    }
    const authenticated = await requireChatMutation(request, this.#sessions);
    if (authenticated instanceof Response) return authenticated;
    return await this.#delete(
      itemMatch[1],
      itemMatch[2],
      authenticated.user.id,
    );
  }

  async #list(
    roomId: string,
    userId: string,
    searchParams: URLSearchParams,
  ): Promise<Response> {
    if ([...searchParams.keys()].some((key) => key !== "before")) {
      return messageJson({ error: "Unsupported query parameter" }, 400);
    }
    const before = searchParams.get("before") ?? undefined;
    if (before !== undefined && !isMessageId(before)) {
      return messageJson({ error: "Invalid message cursor" }, 400);
    }

    const [room, member] = await Promise.all([
      this.#repository.getRoom(roomId),
      this.#repository.getMember(roomId, userId),
    ]);
    if (!room) return messageJson({ error: "Room not found" }, 404);
    if (!member) {
      return messageJson({ error: "Room membership required" }, 403);
    }

    const page = await this.#repository.listMessages(roomId, {
      limit: chatLimits.defaultPageSize,
      before,
      visibleFrom: member.visibleFrom,
    });
    const authorIds = [
      ...new Set(page.messages.map((message) => message.authorId)),
    ];
    const authors = new Map(
      await Promise.all(authorIds.map(async (authorId) => {
        const user = await this.#repository.getUser(authorId);
        return [
          authorId,
          !user || user.deletedAt ? "退会したユーザー" : user.displayName,
        ] as const;
      })),
    );
    return messageJson({
      messages: page.messages.map((message) =>
        publicMessage(message, authors.get(message.authorId) ?? null)
      ),
      nextBefore: page.nextBefore,
    });
  }

  async #create(
    roomId: string,
    userId: string,
    body: string,
  ): Promise<Response> {
    let rateLimitConsumed = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [roomEntry, memberEntry] = await Promise.all([
        this.#repository.getRoomEntry(roomId),
        this.#repository.getMemberEntry(roomId, userId),
      ]);
      if (!roomEntry.value || !roomEntry.versionstamp) {
        return messageJson({ error: "Room not found" }, 404);
      }
      if (!memberEntry.value || !memberEntry.versionstamp) {
        return messageJson({ error: "Room membership required" }, 403);
      }
      if (
        memberEntry.value.role !== "owner" &&
        memberEntry.value.role !== "writer"
      ) {
        return messageJson({ error: "Write permission required" }, 403);
      }

      const now = this.#now();
      if (!rateLimitConsumed) {
        const limit = await this.#repository.consumeRateLimit(
          "message",
          userId,
          now,
          10 * 1000,
          chatLimits.maxMessagesPerTenSeconds,
        );
        if (!limit.allowed) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil(
              (new Date(limit.retryAt).getTime() - now.getTime()) / 1000,
            ),
          );
          return messageJson(
            {
              error: "Message rate limit reached",
              retryAt: limit.retryAt,
            },
            429,
            { "retry-after": String(retryAfterSeconds) },
          );
        }
        rateLimitConsumed = true;
      }
      const id = this.#generateMessageId(now);
      if (!isMessageId(id)) continue;
      const message: Message = {
        id,
        roomId,
        authorId: userId,
        body,
        createdAt: now.toISOString(),
        deletedAt: null,
        deletedBy: null,
      };
      const event: ChatEventDraft = {
        type: "message-created",
        audience: "room-members",
        roomId,
        actorId: userId,
        targetUserId: null,
        createdAt: message.createdAt,
        payload: {
          messageId: message.id,
          authorId: message.authorId,
          body: message.body,
          createdAt: message.createdAt,
        },
      };
      if (
        await this.#repository.createMessage(
          message,
          roomEntry.versionstamp,
          memberEntry.versionstamp,
          event,
        )
      ) {
        const user = await this.#repository.getUser(userId);
        return messageJson(
          { message: publicMessage(message, user?.displayName ?? null) },
          201,
        );
      }
    }
    return messageJson({ error: "Could not create message" }, 503);
  }

  async #delete(
    roomId: string,
    messageId: string,
    userId: string,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [roomEntry, memberEntry, messageEntry] = await Promise.all([
        this.#repository.getRoomEntry(roomId),
        this.#repository.getMemberEntry(roomId, userId),
        this.#repository.getMessageEntry(roomId, messageId),
      ]);
      if (!roomEntry.value || !roomEntry.versionstamp) {
        return messageJson({ error: "Room not found" }, 404);
      }
      if (!memberEntry.value || !memberEntry.versionstamp) {
        return messageJson({ error: "Room membership required" }, 403);
      }
      const message = messageEntry.value;
      if (
        !message || !messageEntry.versionstamp ||
        message.createdAt < memberEntry.value.visibleFrom
      ) {
        return messageJson({ error: "Message not found" }, 404);
      }

      const isOwner = roomEntry.value.ownerId === userId &&
        memberEntry.value.role === "owner";
      const canDeleteOwn = message.authorId === userId &&
        memberEntry.value.role === "writer";
      if (!isOwner && !canDeleteOwn) {
        return messageJson({ error: "Message deletion is not allowed" }, 403);
      }
      if (message.deletedAt) {
        return messageJson({
          message: publicMessage(message, null),
        });
      }

      const deletedAt = this.#now().toISOString();
      const deleted: Message = {
        ...message,
        body: null,
        deletedAt,
        deletedBy: userId,
      };
      const event: ChatEventDraft = {
        type: "message-deleted",
        audience: "room-members",
        roomId,
        actorId: userId,
        targetUserId: null,
        createdAt: deletedAt,
        payload: {
          messageId: deleted.id,
          deletedAt: deleted.deletedAt,
          deletedBy: deleted.deletedBy,
        },
      };
      if (
        await this.#repository.redactMessage(
          deleted,
          userId,
          messageEntry.versionstamp,
          roomEntry.versionstamp,
          memberEntry.versionstamp,
          event,
        )
      ) {
        return messageJson({ message: publicMessage(deleted, null) });
      }
    }
    return messageJson({ error: "Could not delete message" }, 503);
  }
}

export function createChatMessageHandler(
  service: ChatMessageService,
): (request: Request) => Promise<Response> {
  return service.handler();
}

function isMessageId(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

function publicMessage(message: Message, authorDisplayName: string | null) {
  return {
    id: message.id,
    roomId: message.roomId,
    authorId: message.authorId,
    authorDisplayName,
    body: message.body,
    createdAt: message.createdAt,
    deletedAt: message.deletedAt,
    deletedBy: message.deletedBy,
  };
}

async function messageBodyFromRequest(
  request: Request,
): Promise<string | Response> {
  const value = await readMessageJson(request);
  if (value instanceof Response) return value;
  if (!value || typeof value !== "object") {
    return invalidMessageBody();
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.body !== "string" ||
    Object.keys(candidate).some((key) => key !== "body")
  ) {
    return invalidMessageBody();
  }
  const length = Array.from(candidate.body).length;
  if (
    length < 1 || length > chatLimits.maxMessageLength ||
    candidate.body.trim().length === 0
  ) {
    return invalidMessageBody();
  }
  return candidate.body;
}

function invalidMessageBody(): Response {
  return messageJson(
    {
      error:
        `Message body must contain 1-${chatLimits.maxMessageLength} characters`,
    },
    400,
  );
}

async function readMessageJson(request: Request): Promise<unknown | Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxMessageRequestBytes) {
    return messageJson({ error: "Request body is too large" }, 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return messageJson({ error: "Could not read request body" }, 400);
  }
  if (new TextEncoder().encode(text).byteLength > maxMessageRequestBytes) {
    return messageJson({ error: "Request body is too large" }, 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    return messageJson({ error: "Invalid JSON" }, 400);
  }
}

function messageJson(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
