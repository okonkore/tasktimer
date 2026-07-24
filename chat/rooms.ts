import { chatLimits, ChatRepository, type Member, type Room } from "./data.ts";
import {
  type AuthenticatedChatRequest,
  ChatSessionService,
  requireChatAuthentication,
  requireChatMutation,
} from "./session.ts";

const maxRoomRequestBytes = 8 * 1024;
const roomIdPattern = /^[A-Za-z0-9_-]{16,64}$/;

type Clock = () => Date;
type RoomIdGenerator = () => string;

export interface RoomServiceOptions {
  repository: ChatRepository;
  sessions: ChatSessionService;
  now?: Clock;
  generateRoomId?: RoomIdGenerator;
}

interface RoomInput {
  name: string;
  description: string;
}

export interface RoomSummary {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  role: "owner" | "viewer" | "writer";
}

export class ChatRoomService {
  readonly #repository: ChatRepository;
  readonly #sessions: ChatSessionService;
  readonly #now: Clock;
  readonly #generateRoomId: RoomIdGenerator;

  constructor(options: RoomServiceOptions) {
    this.#repository = options.repository;
    this.#sessions = options.sessions;
    this.#now = options.now ?? (() => new Date());
    this.#generateRoomId = options.generateRoomId ?? generateRoomId;
  }

  async listRooms(userId: string): Promise<{
    ownedRooms: RoomSummary[];
    joinedRooms: RoomSummary[];
  }> {
    const [ownedIds, memberIds] = await Promise.all([
      this.#repository.listRoomIdsByOwner(userId),
      this.#repository.listRoomIdsByMember(userId),
    ]);
    const ownedRoomIds = new Set(ownedIds);
    const rooms = await Promise.all(
      [...new Set([...ownedIds, ...memberIds])].map(async (roomId) => {
        const [room, member] = await Promise.all([
          this.#repository.getRoom(roomId),
          this.#repository.getMember(roomId, userId),
        ]);
        if (!room || !member) return null;
        return { room, member };
      }),
    );

    const ownedRooms: RoomSummary[] = [];
    const joinedRooms: RoomSummary[] = [];
    for (const result of rooms) {
      if (!result) continue;
      const summary = roomSummary(result.room, result.member.role);
      if (ownedRoomIds.has(result.room.id) || result.room.ownerId === userId) {
        ownedRooms.push(summary);
      } else {
        joinedRooms.push(summary);
      }
    }
    const newestFirst = (left: RoomSummary, right: RoomSummary) =>
      right.updatedAt.localeCompare(left.updatedAt);
    ownedRooms.sort(newestFirst);
    joinedRooms.sort(newestFirst);
    return { ownedRooms, joinedRooms };
  }

  async createRoom(
    authenticated: AuthenticatedChatRequest,
    input: RoomInput,
  ): Promise<{ room: Room } | "limit" | "conflict"> {
    const timestamp = this.#now().toISOString();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const roomId = this.#generateRoomId();
      if (!roomIdPattern.test(roomId)) continue;
      const room: Room = {
        id: roomId,
        ownerId: authenticated.user.id,
        name: input.name,
        description: input.description,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const owner: Member = {
        roomId,
        userId: authenticated.user.id,
        role: "owner",
        visibleFrom: timestamp,
        joinedAt: timestamp,
        updatedAt: timestamp,
      };
      const result = await this.#repository.createRoomWithOwner(room, owner);
      if (result === "created") return { room };
      if (result === "limit") return "limit";
    }
    return "conflict";
  }

  async getRoomForUser(
    roomId: string,
    userId: string,
  ): Promise<
    | { room: Room; isOwner: boolean; membership: Member }
    | {
      access: {
        status:
          | "not-requested"
          | "pending"
          | "approved"
          | "rejected"
          | "removed";
        rejectedUntil: string | null;
        canRequest: boolean;
      };
    }
    | null
  > {
    const room = await this.#repository.getRoom(roomId);
    if (!room) return null;
    const member = await this.#repository.getMember(roomId, userId);
    if (member) {
      return { room, isOwner: room.ownerId === userId, membership: member };
    }

    const request = await this.#repository.getJoinRequest(roomId, userId);
    const rejectedUntil = request?.status === "rejected"
      ? request.rejectedUntil
      : null;
    return {
      access: {
        status: request?.status ?? "not-requested",
        rejectedUntil,
        canRequest: !request || request.status === "removed" ||
          (request.status === "rejected" &&
            rejectedUntil !== null &&
            this.#now().getTime() >= new Date(rejectedUntil).getTime()),
      },
    };
  }

  async updateRoom(
    authenticated: AuthenticatedChatRequest,
    roomId: string,
    input: RoomInput,
  ): Promise<Room | "not-found" | "forbidden" | "conflict"> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entry = await this.#repository.getRoomEntry(roomId);
      if (!entry.value || !entry.versionstamp) return "not-found";
      if (entry.value.ownerId !== authenticated.user.id) return "forbidden";
      const room: Room = {
        ...entry.value,
        name: input.name,
        description: input.description,
        updatedAt: this.#now().toISOString(),
      };
      if (await this.#repository.updateRoom(room, entry.versionstamp)) {
        return room;
      }
    }
    return "conflict";
  }

  async deleteRoom(
    authenticated: AuthenticatedChatRequest,
    roomId: string,
    confirmationName: string,
  ): Promise<
    "deleted" | "not-found" | "forbidden" | "name-mismatch" | "conflict"
  > {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entry = await this.#repository.getRoomEntry(roomId);
      if (!entry.value || !entry.versionstamp) {
        const deletion = await this.#repository.getRoomDeletion(roomId);
        if (!deletion) return "not-found";
        if (deletion.ownerId !== authenticated.user.id) return "forbidden";
        // Always sweep again, even after a previous completion marker. This
        // keeps retries safe if an earlier large scan was interrupted or if a
        // stale in-flight mutation briefly recreated an associated index.
        await this.#repository.deleteRoomAssociatedData(roomId);
        if (!deletion.completedAt) {
          await this.#repository.finishRoomDeletion(
            deletion,
            this.#now().toISOString(),
          );
        }
        return "deleted";
      }
      if (entry.value.ownerId !== authenticated.user.id) return "forbidden";
      if (confirmationName !== entry.value.name) return "name-mismatch";
      if (
        await this.#repository.beginRoomDeletion(
          entry.value,
          entry.versionstamp,
          this.#now().toISOString(),
        )
      ) {
        const deletion = await this.#repository.getRoomDeletion(roomId);
        if (!deletion) return "conflict";
        await this.#repository.deleteRoomAssociatedData(roomId);
        await this.#repository.finishRoomDeletion(
          deletion,
          this.#now().toISOString(),
        );
        return "deleted";
      }
    }
    return "conflict";
  }

  handler(): (request: Request) => Promise<Response> {
    return (request) => this.handle(request);
  }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/chat/rooms") {
      if (request.method === "GET") {
        const authenticated = await requireChatAuthentication(
          request,
          this.#sessions,
        );
        if (authenticated instanceof Response) return authenticated;
        return roomJson(await this.listRooms(authenticated.user.id));
      }
      if (request.method === "POST") {
        const authenticated = await requireChatMutation(
          request,
          this.#sessions,
        );
        if (authenticated instanceof Response) return authenticated;
        const input = await roomInputFromRequest(request);
        if (input instanceof Response) return input;
        const result = await this.createRoom(authenticated, input);
        if (result === "limit") {
          return roomJson(
            { error: `You can own at most ${chatLimits.maxOwnedRooms} rooms` },
            409,
          );
        }
        if (result === "conflict") {
          return roomJson({ error: "Could not create room" }, 503);
        }
        return roomJson({ room: result.room }, 201, {
          location: `/chat/rooms/${result.room.id}`,
        });
      }
      return roomJson({ error: "Method not allowed" }, 405, {
        Allow: "GET, POST",
      });
    }

    const match = path.match(/^\/api\/chat\/rooms\/([A-Za-z0-9_-]{16,64})$/);
    if (!match) return roomJson({ error: "Not found" }, 404);
    const roomId = match[1];

    if (request.method === "GET") {
      const authenticated = await requireChatAuthentication(
        request,
        this.#sessions,
      );
      if (authenticated instanceof Response) return authenticated;
      const result = await this.getRoomForUser(roomId, authenticated.user.id);
      if (!result) return roomJson({ error: "Room not found" }, 404);
      if ("access" in result) {
        return roomJson(
          { error: "Room membership required", access: result.access },
          403,
        );
      }
      return roomJson({
        room: result.room,
        isOwner: result.isOwner,
        membership: {
          role: result.membership.role,
          visibleFrom: result.membership.visibleFrom,
        },
      });
    }

    if (request.method === "PATCH") {
      const authenticated = await requireChatMutation(request, this.#sessions);
      if (authenticated instanceof Response) return authenticated;
      const input = await roomInputFromRequest(request);
      if (input instanceof Response) return input;
      const result = await this.updateRoom(authenticated, roomId, input);
      if (result === "not-found") {
        return roomJson({ error: "Room not found" }, 404);
      }
      if (result === "forbidden") {
        return roomJson({ error: "Only the owner can update this room" }, 403);
      }
      if (result === "conflict") {
        return roomJson({ error: "Could not update room" }, 503);
      }
      return roomJson({ room: result });
    }

    if (request.method === "DELETE") {
      const authenticated = await requireChatMutation(request, this.#sessions);
      if (authenticated instanceof Response) return authenticated;
      const confirmationName = await roomDeleteInputFromRequest(request);
      if (confirmationName instanceof Response) return confirmationName;
      try {
        const result = await this.deleteRoom(
          authenticated,
          roomId,
          confirmationName,
        );
        if (result === "not-found") {
          return roomJson({ error: "Room not found" }, 404);
        }
        if (result === "forbidden") {
          return roomJson(
            { error: "Only the owner can delete this room" },
            403,
          );
        }
        if (result === "name-mismatch") {
          return roomJson({ error: "Room name does not match" }, 400);
        }
        if (result === "conflict") {
          return roomJson({ error: "Could not delete room" }, 503);
        }
        return roomJson({ ok: true });
      } catch {
        return roomJson(
          { error: "Room deletion is incomplete; retry the request" },
          503,
        );
      }
    }

    return roomJson({ error: "Method not allowed" }, 405, {
      Allow: "GET, PATCH, DELETE",
    });
  }
}

export function createChatRoomHandler(
  service: ChatRoomService,
): (request: Request) => Promise<Response> {
  return service.handler();
}

export function generateRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function roomSummary(room: Room, role: Member["role"]): RoomSummary {
  return {
    id: room.id,
    name: room.name,
    description: room.description,
    ownerId: room.ownerId,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    role,
  };
}

async function roomInputFromRequest(
  request: Request,
): Promise<RoomInput | Response> {
  const value = await readRoomJson(request);
  if (value instanceof Response) return value;
  if (!value || typeof value !== "object") {
    return roomJson({ error: "Invalid room" }, 400);
  }
  const candidate = value as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const description = typeof candidate.description === "string"
    ? candidate.description.trim()
    : "";
  if (
    name.length < 1 || name.length > 50 || description.length > 200 ||
    Object.keys(candidate).some((key) =>
      key !== "name" && key !== "description"
    )
  ) {
    return roomJson(
      {
        error:
          "Room name must be 1-50 characters and description at most 200 characters",
      },
      400,
    );
  }
  return { name, description };
}

async function roomDeleteInputFromRequest(
  request: Request,
): Promise<string | Response> {
  const value = await readRoomJson(request);
  if (value instanceof Response) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return roomJson({ error: "Room name confirmation is required" }, 400);
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 1 ||
    typeof candidate.confirmationName !== "string" ||
    candidate.confirmationName.length > 50
  ) {
    return roomJson({ error: "Invalid room name confirmation" }, 400);
  }
  return candidate.confirmationName;
}

async function readRoomJson(request: Request): Promise<unknown | Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxRoomRequestBytes) {
    return roomJson({ error: "Request body is too large" }, 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return roomJson({ error: "Could not read request body" }, 400);
  }
  if (new TextEncoder().encode(text).byteLength > maxRoomRequestBytes) {
    return roomJson({ error: "Request body is too large" }, 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    return roomJson({ error: "Invalid JSON" }, 400);
  }
}

function roomJson(
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
