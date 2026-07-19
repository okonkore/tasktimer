import {
  ChatRepository,
  type JoinRequest,
  type Member,
  type MemberRole,
} from "./data.ts";
import {
  ChatSessionService,
  requireChatAuthentication,
  requireChatMutation,
} from "./session.ts";

const rejectionCooldownMilliseconds = 24 * 60 * 60 * 1000;
const maxJoinRequestBytes = 8 * 1024;
const roomIdPart = "([A-Za-z0-9_-]{16,64})";
const userIdPart = "([A-Za-z0-9_-]{1,100})";
const requestCollectionPattern = new RegExp(
  `^/api/chat/rooms/${roomIdPart}/requests$`,
);
const requestActionPattern = new RegExp(
  `^/api/chat/rooms/${roomIdPart}/requests/${userIdPart}/(approve|reject)$`,
);
const memberCollectionPattern = new RegExp(
  `^/api/chat/rooms/${roomIdPart}/members$`,
);

type Clock = () => Date;
type JoinRole = Extract<MemberRole, "viewer" | "writer">;

export interface JoinRequestServiceOptions {
  repository: ChatRepository;
  sessions: ChatSessionService;
  now?: Clock;
}

export class ChatJoinRequestService {
  readonly #repository: ChatRepository;
  readonly #sessions: ChatSessionService;
  readonly #now: Clock;

  constructor(options: JoinRequestServiceOptions) {
    this.#repository = options.repository;
    this.#sessions = options.sessions;
    this.#now = options.now ?? (() => new Date());
  }

  handler(): (request: Request) => Promise<Response> {
    return (request) => this.handle(request);
  }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const memberMatch = path.match(memberCollectionPattern);
    if (memberMatch) {
      if (request.method !== "GET") {
        return joinJson({ error: "Method not allowed" }, 405, {
          Allow: "GET",
        });
      }
      const authenticated = await requireChatAuthentication(
        request,
        this.#sessions,
      );
      if (authenticated instanceof Response) return authenticated;
      return await this.#listMembers(memberMatch[1], authenticated.user.id);
    }
    const collectionMatch = path.match(requestCollectionPattern);
    if (collectionMatch) {
      const roomId = collectionMatch[1];
      if (request.method === "POST") {
        const authenticated = await requireChatMutation(
          request,
          this.#sessions,
        );
        if (authenticated instanceof Response) return authenticated;
        return await this.#submit(roomId, authenticated.user.id);
      }
      if (request.method === "GET") {
        const authenticated = await requireChatAuthentication(
          request,
          this.#sessions,
        );
        if (authenticated instanceof Response) return authenticated;
        return await this.#listPending(roomId, authenticated.user.id);
      }
      return joinJson({ error: "Method not allowed" }, 405, {
        Allow: "GET, POST",
      });
    }

    const actionMatch = path.match(requestActionPattern);
    if (!actionMatch) return joinJson({ error: "Not found" }, 404);
    if (request.method !== "POST") {
      return joinJson({ error: "Method not allowed" }, 405, {
        Allow: "POST",
      });
    }

    const authenticated = await requireChatMutation(request, this.#sessions);
    if (authenticated instanceof Response) return authenticated;
    const [, roomId, applicantId, action] = actionMatch;
    if (action === "approve") {
      const role = await approvalRoleFromRequest(request);
      if (role instanceof Response) return role;
      return await this.#approve(
        roomId,
        applicantId,
        authenticated.user.id,
        role,
      );
    }
    return await this.#reject(
      roomId,
      applicantId,
      authenticated.user.id,
    );
  }

  async #submit(roomId: string, userId: string): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [roomEntry, memberEntry, requestEntry] = await Promise.all([
        this.#repository.getRoomEntry(roomId),
        this.#repository.getMemberEntry(roomId, userId),
        this.#repository.getJoinRequestEntry(roomId, userId),
      ]);
      if (!roomEntry.value || !roomEntry.versionstamp) {
        return joinJson({ error: "Room not found" }, 404);
      }
      if (roomEntry.value.ownerId === userId || memberEntry.value) {
        return joinJson({ error: "You are already a room member" }, 409);
      }

      const existing = requestEntry.value;
      if (existing?.status === "pending") {
        return joinJson({ error: "A join request is already pending" }, 409);
      }
      if (existing?.status === "approved") {
        return joinJson({ error: "The join request is already approved" }, 409);
      }

      const now = this.#now();
      if (existing?.status === "rejected") {
        const retryAtMilliseconds = existing.rejectedUntil
          ? new Date(existing.rejectedUntil).getTime()
          : Number.NaN;
        const hasValidRetryAt = Number.isFinite(retryAtMilliseconds);
        if (!hasValidRetryAt || now.getTime() < retryAtMilliseconds) {
          const retryAfter = hasValidRetryAt
            ? Math.max(
              1,
              Math.ceil((retryAtMilliseconds - now.getTime()) / 1000),
            )
            : Math.ceil(rejectionCooldownMilliseconds / 1000);
          return joinJson(
            {
              error: "A rejected request can be submitted again after 24 hours",
              retryAt: hasValidRetryAt
                ? new Date(retryAtMilliseconds).toISOString()
                : null,
            },
            429,
            { "retry-after": String(retryAfter) },
          );
        }
      }

      const timestamp = now.toISOString();
      const joinRequest: JoinRequest = {
        roomId,
        userId,
        status: "pending",
        requestedAt: timestamp,
        reviewedAt: null,
        rejectedUntil: null,
        emailNotifiedAt: null,
      };
      if (
        await this.#repository.replaceJoinRequest(
          joinRequest,
          requestEntry.versionstamp,
          memberEntry.versionstamp,
          roomEntry.versionstamp,
        )
      ) {
        return joinJson({ request: publicJoinRequest(joinRequest) }, 201);
      }
    }
    return joinJson({ error: "Could not submit join request" }, 503);
  }

  async #listPending(roomId: string, ownerId: string): Promise<Response> {
    const room = await this.#repository.getRoom(roomId);
    if (!room) return joinJson({ error: "Room not found" }, 404);
    if (room.ownerId !== ownerId) {
      return joinJson(
        { error: "Only the owner can view join requests" },
        403,
      );
    }

    const pending = await this.#repository.listJoinRequests(roomId, "pending");
    const requests = (await Promise.all(pending.map(async (joinRequest) => {
      const user = await this.#repository.getUser(joinRequest.userId);
      if (!user || user.deletedAt) return null;
      return {
        ...publicJoinRequest(joinRequest),
        applicant: {
          id: user.id,
          displayName: user.displayName,
        },
      };
    }))).filter((value) => value !== null);
    return joinJson({ requests });
  }

  async #listMembers(roomId: string, userId: string): Promise<Response> {
    const [room, requesterMembership] = await Promise.all([
      this.#repository.getRoom(roomId),
      this.#repository.getMember(roomId, userId),
    ]);
    if (!room) return joinJson({ error: "Room not found" }, 404);
    if (!requesterMembership) {
      return joinJson({ error: "Room membership required" }, 403);
    }
    const members = await this.#repository.listMembers(roomId);
    const publicMembers = (await Promise.all(members.map(async (member) => {
      const user = await this.#repository.getUser(member.userId);
      if (!user || user.deletedAt) return null;
      return {
        userId: member.userId,
        displayName: user.displayName ?? "退会したユーザー",
        role: member.role,
        joinedAt: member.joinedAt,
      };
    }))).filter((member) => member !== null);
    return joinJson({ members: publicMembers });
  }

  async #approve(
    roomId: string,
    applicantId: string,
    ownerId: string,
    role: JoinRole,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [roomEntry, requestEntry, memberEntry] = await Promise.all([
        this.#repository.getRoomEntry(roomId),
        this.#repository.getJoinRequestEntry(roomId, applicantId),
        this.#repository.getMemberEntry(roomId, applicantId),
      ]);
      if (!roomEntry.value || !roomEntry.versionstamp) {
        return joinJson({ error: "Room not found" }, 404);
      }
      if (roomEntry.value.ownerId !== ownerId) {
        return joinJson(
          { error: "Only the owner can approve join requests" },
          403,
        );
      }
      if (!requestEntry.value || !requestEntry.versionstamp) {
        return joinJson({ error: "Join request not found" }, 404);
      }
      if (requestEntry.value.status !== "pending" || memberEntry.value) {
        return joinJson({ error: "Join request is not pending" }, 409);
      }

      const timestamp = this.#now().toISOString();
      const joinRequest: JoinRequest = {
        ...requestEntry.value,
        status: "approved",
        reviewedAt: timestamp,
        rejectedUntil: null,
      };
      const member: Member = {
        roomId,
        userId: applicantId,
        role,
        visibleFrom: timestamp,
        joinedAt: timestamp,
        updatedAt: timestamp,
      };
      if (
        await this.#repository.approveJoinRequest(
          joinRequest,
          member,
          requestEntry.versionstamp,
          roomEntry.versionstamp,
        )
      ) {
        return joinJson({
          request: publicJoinRequest(joinRequest),
          membership: {
            userId: member.userId,
            role: member.role,
            visibleFrom: member.visibleFrom,
          },
        });
      }
    }
    return joinJson({ error: "Could not approve join request" }, 503);
  }

  async #reject(
    roomId: string,
    applicantId: string,
    ownerId: string,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [roomEntry, requestEntry, memberEntry] = await Promise.all([
        this.#repository.getRoomEntry(roomId),
        this.#repository.getJoinRequestEntry(roomId, applicantId),
        this.#repository.getMemberEntry(roomId, applicantId),
      ]);
      if (!roomEntry.value || !roomEntry.versionstamp) {
        return joinJson({ error: "Room not found" }, 404);
      }
      if (roomEntry.value.ownerId !== ownerId) {
        return joinJson(
          { error: "Only the owner can reject join requests" },
          403,
        );
      }
      if (!requestEntry.value || !requestEntry.versionstamp) {
        return joinJson({ error: "Join request not found" }, 404);
      }
      if (requestEntry.value.status !== "pending" || memberEntry.value) {
        return joinJson({ error: "Join request is not pending" }, 409);
      }

      const now = this.#now();
      const rejectedUntil = new Date(
        now.getTime() + rejectionCooldownMilliseconds,
      );
      const joinRequest: JoinRequest = {
        ...requestEntry.value,
        status: "rejected",
        reviewedAt: now.toISOString(),
        rejectedUntil: rejectedUntil.toISOString(),
      };
      if (
        await this.#repository.rejectJoinRequest(
          joinRequest,
          requestEntry.versionstamp,
          roomEntry.versionstamp,
        )
      ) {
        return joinJson({ request: publicJoinRequest(joinRequest) });
      }
    }
    return joinJson({ error: "Could not reject join request" }, 503);
  }
}

export function createChatJoinRequestHandler(
  service: ChatJoinRequestService,
): (request: Request) => Promise<Response> {
  return service.handler();
}

function publicJoinRequest(request: JoinRequest) {
  return {
    roomId: request.roomId,
    userId: request.userId,
    status: request.status,
    requestedAt: request.requestedAt,
    reviewedAt: request.reviewedAt,
    rejectedUntil: request.rejectedUntil,
  };
}

async function approvalRoleFromRequest(
  request: Request,
): Promise<JoinRole | Response> {
  const value = await readJoinJson(request);
  if (value instanceof Response) return value;
  if (!value || typeof value !== "object") {
    return joinJson({ error: "Approval role must be viewer or writer" }, 400);
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.role !== "viewer" && candidate.role !== "writer") ||
    Object.keys(candidate).some((key) => key !== "role")
  ) {
    return joinJson({ error: "Approval role must be viewer or writer" }, 400);
  }
  return candidate.role;
}

async function readJoinJson(request: Request): Promise<unknown | Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxJoinRequestBytes) {
    return joinJson({ error: "Request body is too large" }, 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return joinJson({ error: "Could not read request body" }, 400);
  }
  if (new TextEncoder().encode(text).byteLength > maxJoinRequestBytes) {
    return joinJson({ error: "Request body is too large" }, 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    return joinJson({ error: "Invalid JSON" }, 400);
  }
}

function joinJson(
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
