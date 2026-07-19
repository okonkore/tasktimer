export type IsoDateTime = string;

export type MemberRole = "owner" | "viewer" | "writer";
export type JoinRequestStatus = "pending" | "approved" | "rejected" | "removed";
export type NotificationType =
  | "join-request"
  | "join-approved"
  | "join-rejected"
  | "permission-changed"
  | "member-removed";

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  emailNotificationsEnabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
}

export interface Session {
  id: string;
  userId: string;
  csrfTokenHash: string;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
}

export interface OtpChallenge {
  email: string;
  codeHash: string;
  failedAttempts: number;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
  lastSentAt: IsoDateTime;
}

export interface Room {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Member {
  roomId: string;
  userId: string;
  role: MemberRole;
  visibleFrom: IsoDateTime;
  joinedAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface JoinRequest {
  roomId: string;
  userId: string;
  status: JoinRequestStatus;
  requestedAt: IsoDateTime;
  reviewedAt: IsoDateTime | null;
  rejectedUntil: IsoDateTime | null;
  emailNotifiedAt: IsoDateTime | null;
}

export interface Message {
  id: string;
  roomId: string;
  authorId: string;
  body: string | null;
  createdAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
  deletedBy: string | null;
}

export interface ReadPosition {
  roomId: string;
  userId: string;
  lastReadMessageId: string | null;
  updatedAt: IsoDateTime;
}

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  roomId: string;
  actorId: string | null;
  createdAt: IsoDateTime;
  readAt: IsoDateTime | null;
  dedupeKey: string | null;
}

export interface RateLimitWindow {
  count: number;
  windowStartedAt: IsoDateTime;
  expiresAt: IsoDateTime;
}

export const chatLimits = Object.freeze({
  maxOwnedRooms: 20,
  maxRoomMembers: 100,
  defaultPageSize: 50,
  maxPageSize: 100,
});

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const chatPrefix = ["chat"] as const;

export const chatKeys = Object.freeze({
  user: (userId: string): Deno.KvKey => [...chatPrefix, "users", userId],
  userByEmail: (email: string): Deno.KvKey => [
    ...chatPrefix,
    "usersByEmail",
    normalizeEmail(email),
  ],
  otp: (
    email: string,
  ): Deno.KvKey => [...chatPrefix, "otp", normalizeEmail(email)],
  session: (
    sessionId: string,
  ): Deno.KvKey => [...chatPrefix, "sessions", sessionId],
  room: (roomId: string): Deno.KvKey => [...chatPrefix, "rooms", roomId],
  roomByOwner: (ownerId: string, roomId: string): Deno.KvKey => [
    ...chatPrefix,
    "roomsByOwner",
    ownerId,
    roomId,
  ],
  member: (roomId: string, userId: string): Deno.KvKey => [
    ...chatPrefix,
    "members",
    roomId,
    userId,
  ],
  request: (roomId: string, userId: string): Deno.KvKey => [
    ...chatPrefix,
    "requests",
    roomId,
    userId,
  ],
  message: (roomId: string, messageId: string): Deno.KvKey => [
    ...chatPrefix,
    "messages",
    roomId,
    messageId,
  ],
  readPosition: (roomId: string, userId: string): Deno.KvKey => [
    ...chatPrefix,
    "readPositions",
    roomId,
    userId,
  ],
  notification: (userId: string, notificationId: string): Deno.KvKey => [
    ...chatPrefix,
    "notifications",
    userId,
    notificationId,
  ],
  rateLimit: (
    category: string,
    subject: string,
    window: string,
  ): Deno.KvKey => [
    ...chatPrefix,
    "rateLimits",
    category,
    subject,
    window,
  ],
});

const sortableEncoding = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const maxSortableTimestamp = 2 ** 48 - 1;

export function createSortableId(date = new Date()): string {
  const time = date.getTime();
  if (!Number.isInteger(time) || time < 0 || time > maxSortableTimestamp) {
    throw new RangeError("Sortable ID timestamp is out of range");
  }

  const random = crypto.getRandomValues(new Uint8Array(16));
  return encodeSortableTimestamp(time) +
    Array.from(random, (value) => sortableEncoding[value & 31]).join("");
}

export function sortableIdLowerBound(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date;
  const time = value.getTime();
  if (!Number.isInteger(time) || time < 0 || time > maxSortableTimestamp) {
    throw new RangeError("Sortable ID timestamp is out of range");
  }
  return encodeSortableTimestamp(time) + "0".repeat(16);
}

function encodeSortableTimestamp(timestamp: number): string {
  let value = BigInt(timestamp);
  const encoded = Array<string>(10);
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = sortableEncoding[Number(value & 31n)];
    value >>= 5n;
  }
  return encoded.join("");
}

function pageSize(value?: number): number {
  if (!Number.isFinite(value)) return chatLimits.defaultPageSize;
  return Math.max(1, Math.min(chatLimits.maxPageSize, Math.floor(value!)));
}

export interface MessagePageOptions {
  limit?: number;
  before?: string;
  visibleFrom?: IsoDateTime;
}

export interface MessagePage {
  messages: Message[];
  nextBefore: string | null;
}

export class ChatRepository {
  constructor(private readonly kv: Deno.Kv) {}

  async createUser(user: User): Promise<boolean> {
    const normalizedUser = { ...user, email: normalizeEmail(user.email) };
    const userKey = chatKeys.user(user.id);
    const emailKey = chatKeys.userByEmail(user.email);
    const result = await this.kv.atomic()
      .check(
        { key: userKey, versionstamp: null },
        { key: emailKey, versionstamp: null },
      )
      .set(userKey, normalizedUser)
      .set(emailKey, user.id)
      .commit();
    return result.ok;
  }

  async getUser(userId: string): Promise<User | null> {
    return (await this.kv.get<User>(chatKeys.user(userId))).value;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const userId =
      (await this.kv.get<string>(chatKeys.userByEmail(email))).value;
    return userId ? await this.getUser(userId) : null;
  }

  async setSession(session: Session): Promise<void> {
    await this.kv.set(chatKeys.session(session.id), session, {
      expireIn: Math.max(1, new Date(session.expiresAt).getTime() - Date.now()),
    });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return (await this.kv.get<Session>(chatKeys.session(sessionId))).value;
  }

  async setOtpChallenge(challenge: OtpChallenge): Promise<void> {
    await this.kv.set(chatKeys.otp(challenge.email), challenge, {
      expireIn: Math.max(
        1,
        new Date(challenge.expiresAt).getTime() - Date.now(),
      ),
    });
  }

  async getOtpChallenge(email: string): Promise<OtpChallenge | null> {
    return (await this.kv.get<OtpChallenge>(chatKeys.otp(email))).value;
  }

  async setRoom(room: Room): Promise<void> {
    await this.kv.atomic()
      .set(chatKeys.room(room.id), room)
      .set(chatKeys.roomByOwner(room.ownerId, room.id), room.id)
      .commit();
  }

  async getRoom(roomId: string): Promise<Room | null> {
    return (await this.kv.get<Room>(chatKeys.room(roomId))).value;
  }

  async listRoomIdsByOwner(
    ownerId: string,
    limit = chatLimits.maxOwnedRooms,
  ): Promise<string[]> {
    const roomIds: string[] = [];
    const entries = this.kv.list<string>(
      { prefix: ["chat", "roomsByOwner", ownerId] },
      { limit: pageSize(limit) },
    );
    for await (const entry of entries) roomIds.push(entry.value);
    return roomIds;
  }

  async setMember(member: Member): Promise<void> {
    await this.kv.set(chatKeys.member(member.roomId, member.userId), member);
  }

  async getMember(roomId: string, userId: string): Promise<Member | null> {
    return (await this.kv.get<Member>(chatKeys.member(roomId, userId))).value;
  }

  async countMembers(
    roomId: string,
    limit = chatLimits.maxRoomMembers + 1,
  ): Promise<number> {
    let count = 0;
    const entries = this.kv.list<Member>(
      { prefix: ["chat", "members", roomId] },
      { limit: Math.max(1, Math.floor(limit)) },
    );
    for await (const _entry of entries) count += 1;
    return count;
  }

  async setJoinRequest(request: JoinRequest): Promise<void> {
    await this.kv.set(
      chatKeys.request(request.roomId, request.userId),
      request,
    );
  }

  async getJoinRequest(
    roomId: string,
    userId: string,
  ): Promise<JoinRequest | null> {
    return (await this.kv.get<JoinRequest>(chatKeys.request(roomId, userId)))
      .value;
  }

  async setMessage(message: Message): Promise<void> {
    await this.kv.set(chatKeys.message(message.roomId, message.id), message);
  }

  async getMessage(roomId: string, messageId: string): Promise<Message | null> {
    return (await this.kv.get<Message>(chatKeys.message(roomId, messageId)))
      .value;
  }

  async listMessages(
    roomId: string,
    options: MessagePageOptions = {},
  ): Promise<MessagePage> {
    const prefix: Deno.KvKey = ["chat", "messages", roomId];
    const startId = options.visibleFrom
      ? sortableIdLowerBound(options.visibleFrom)
      : "";
    const endId = options.before ?? "\uffff";
    if (endId <= startId) return { messages: [], nextBefore: null };
    const selector: Deno.KvListSelector = {
      start: [...prefix, startId],
      end: [...prefix, endId],
    };

    const messages: Message[] = [];
    const entries = this.kv.list<Message>(selector, {
      limit: pageSize(options.limit),
      reverse: true,
    });
    for await (const entry of entries) messages.push(entry.value);
    return {
      messages,
      nextBefore: messages.at(-1)?.id ?? null,
    };
  }

  async setReadPosition(position: ReadPosition): Promise<void> {
    await this.kv.set(
      chatKeys.readPosition(position.roomId, position.userId),
      position,
    );
  }

  async getReadPosition(
    roomId: string,
    userId: string,
  ): Promise<ReadPosition | null> {
    return (await this.kv.get<ReadPosition>(
      chatKeys.readPosition(roomId, userId),
    )).value;
  }

  async setNotification(notification: Notification): Promise<void> {
    await this.kv.set(
      chatKeys.notification(notification.userId, notification.id),
      notification,
    );
  }

  async setRateLimit(
    category: string,
    subject: string,
    window: string,
    value: RateLimitWindow,
  ): Promise<void> {
    await this.kv.set(chatKeys.rateLimit(category, subject, window), value, {
      expireIn: Math.max(1, new Date(value.expiresAt).getTime() - Date.now()),
    });
  }
}
