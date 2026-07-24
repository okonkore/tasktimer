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

export interface RoomDeletion {
  roomId: string;
  ownerId: string;
  startedAt: IsoDateTime;
  completedAt: IsoDateTime | null;
}

export interface AccountDeletion {
  userId: string;
  sessionId: string;
  startedAt: IsoDateTime;
}

interface RoomOwnerCount {
  count: number;
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

export type ChatEventType =
  | "message-created"
  | "message-deleted"
  | "join-requested"
  | "join-approved"
  | "join-rejected"
  | "permission-changed"
  | "member-removed";

export type ChatEventAudience = "room-members" | "room-owner" | "user";

export interface ChatEvent {
  id: string;
  type: ChatEventType;
  audience: ChatEventAudience;
  roomId: string;
  actorId: string;
  targetUserId: string | null;
  createdAt: IsoDateTime;
  payload: Record<string, unknown>;
}

export type ChatEventDraft = Omit<ChatEvent, "id">;

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
  maxMessageLength: 2_000,
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
  roomByMember: (userId: string, roomId: string): Deno.KvKey => [
    ...chatPrefix,
    "roomsByMember",
    userId,
    roomId,
  ],
  roomOwnerCount: (ownerId: string): Deno.KvKey => [
    ...chatPrefix,
    "roomOwnerCounts",
    ownerId,
  ],
  roomDeletion: (roomId: string): Deno.KvKey => [
    ...chatPrefix,
    "roomDeletions",
    roomId,
  ],
  accountDeletion: (userId: string): Deno.KvKey => [
    ...chatPrefix,
    "accountDeletions",
    userId,
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
  eventSequence: (): Deno.KvKey => [...chatPrefix, "eventSequence"],
  event: (eventId: string): Deno.KvKey => [
    ...chatPrefix,
    "events",
    eventId,
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

function otpChallengeExpireIn(challenge: OtpChallenge): number {
  return Math.max(1, new Date(challenge.expiresAt).getTime() - Date.now());
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

  async getUserEntry(userId: string): Promise<Deno.KvEntryMaybe<User>> {
    return await this.kv.get<User>(chatKeys.user(userId));
  }

  async updateUserDisplayName(
    userId: string,
    displayName: string,
    updatedAt: IsoDateTime,
  ): Promise<User | null> {
    return await this.updateUserProfile(userId, { displayName }, updatedAt);
  }

  async updateUserProfile(
    userId: string,
    changes: Partial<Pick<User, "displayName" | "emailNotificationsEnabled">>,
    updatedAt: IsoDateTime,
  ): Promise<User | null> {
    const key = chatKeys.user(userId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entry = await this.kv.get<User>(key);
      if (!entry.value || !entry.versionstamp) return null;

      const user: User = { ...entry.value, ...changes, updatedAt };
      const result = await this.kv.atomic()
        .check({ key, versionstamp: entry.versionstamp })
        .set(key, user)
        .commit();
      if (result.ok) return user;
    }
    return null;
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

  async createSession(session: Session): Promise<boolean> {
    const key = chatKeys.session(session.id);
    const result = await this.kv.atomic()
      .check({ key, versionstamp: null })
      .set(key, session, {
        expireIn: Math.max(
          1,
          new Date(session.expiresAt).getTime() - Date.now(),
        ),
      })
      .commit();
    return result.ok;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return (await this.kv.get<Session>(chatKeys.session(sessionId))).value;
  }

  async getSessionEntry(
    sessionId: string,
  ): Promise<Deno.KvEntryMaybe<Session>> {
    return await this.kv.get<Session>(chatKeys.session(sessionId));
  }

  async deleteSession(
    sessionId: string,
    expectedVersionstamp?: string,
  ): Promise<boolean> {
    const key = chatKeys.session(sessionId);
    if (!expectedVersionstamp) {
      await this.kv.delete(key);
      return true;
    }
    const result = await this.kv.atomic()
      .check({ key, versionstamp: expectedVersionstamp })
      .delete(key)
      .commit();
    return result.ok;
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

  async getOtpChallengeEntry(
    email: string,
  ): Promise<Deno.KvEntryMaybe<OtpChallenge>> {
    return await this.kv.get<OtpChallenge>(chatKeys.otp(email));
  }

  async replaceOtpChallenge(
    challenge: OtpChallenge,
    expectedVersionstamp: string | null,
  ): Promise<string | null> {
    const key = chatKeys.otp(challenge.email);
    const result = await this.kv.atomic()
      .check({ key, versionstamp: expectedVersionstamp })
      .set(key, challenge, { expireIn: otpChallengeExpireIn(challenge) })
      .commit();
    return result.ok ? result.versionstamp : null;
  }

  async deleteOtpChallenge(
    email: string,
    expectedVersionstamp: string,
  ): Promise<boolean> {
    const key = chatKeys.otp(email);
    const result = await this.kv.atomic()
      .check({ key, versionstamp: expectedVersionstamp })
      .delete(key)
      .commit();
    return result.ok;
  }

  async setRoom(room: Room): Promise<void> {
    await this.kv.atomic()
      .set(chatKeys.room(room.id), room)
      .set(chatKeys.roomByOwner(room.ownerId, room.id), room.id)
      .commit();
  }

  async createRoomWithOwner(room: Room, owner: Member): Promise<
    "created" | "limit" | "conflict"
  > {
    const roomKey = chatKeys.room(room.id);
    const ownerIndexKey = chatKeys.roomByOwner(room.ownerId, room.id);
    const ownerMemberKey = chatKeys.member(room.id, room.ownerId);
    const memberIndexKey = chatKeys.roomByMember(room.ownerId, room.id);
    const countKey = chatKeys.roomOwnerCount(room.ownerId);
    const accountDeletionKey = chatKeys.accountDeletion(room.ownerId);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const countEntry = await this.kv.get<RoomOwnerCount>(countKey);
      const count = countEntry.value?.count ?? 0;
      if (count >= chatLimits.maxOwnedRooms) return "limit";

      const result = await this.kv.atomic()
        .check(
          { key: roomKey, versionstamp: null },
          { key: ownerIndexKey, versionstamp: null },
          { key: ownerMemberKey, versionstamp: null },
          { key: memberIndexKey, versionstamp: null },
          { key: countKey, versionstamp: countEntry.versionstamp },
          { key: accountDeletionKey, versionstamp: null },
        )
        .set(roomKey, room)
        .set(ownerIndexKey, room.id)
        .set(ownerMemberKey, owner)
        .set(memberIndexKey, room.id)
        .set(countKey, { count: count + 1 } satisfies RoomOwnerCount)
        .commit();
      if (result.ok) return "created";
    }
    return "conflict";
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

  async listRoomIdsByMember(
    userId: string,
    limit = chatLimits.maxOwnedRooms + chatLimits.maxRoomMembers,
  ): Promise<string[]> {
    const roomIds: string[] = [];
    const entries = this.kv.list<string>(
      { prefix: ["chat", "roomsByMember", userId] },
      { limit: Math.max(1, Math.floor(limit)) },
    );
    for await (const entry of entries) roomIds.push(entry.value);
    return roomIds;
  }

  async updateRoom(
    room: Room,
    expectedVersionstamp: string,
  ): Promise<boolean> {
    const result = await this.kv.atomic()
      .check({
        key: chatKeys.room(room.id),
        versionstamp: expectedVersionstamp,
      })
      .set(chatKeys.room(room.id), room)
      .commit();
    return result.ok;
  }

  async getRoomEntry(roomId: string): Promise<Deno.KvEntryMaybe<Room>> {
    return await this.kv.get<Room>(chatKeys.room(roomId));
  }

  async getRoomDeletion(roomId: string): Promise<RoomDeletion | null> {
    return (await this.kv.get<RoomDeletion>(chatKeys.roomDeletion(roomId)))
      .value;
  }

  async beginRoomDeletion(
    room: Room,
    expectedRoomVersionstamp: string,
    startedAt: IsoDateTime,
  ): Promise<boolean> {
    const countKey = chatKeys.roomOwnerCount(room.ownerId);
    const countEntry = await this.kv.get<RoomOwnerCount>(countKey);
    const count = countEntry.value?.count ?? 0;
    if (count < 1) return false;
    const deletion: RoomDeletion = {
      roomId: room.id,
      ownerId: room.ownerId,
      startedAt,
      completedAt: null,
    };
    let operation = this.kv.atomic()
      .check(
        {
          key: chatKeys.room(room.id),
          versionstamp: expectedRoomVersionstamp,
        },
        {
          key: chatKeys.roomDeletion(room.id),
          versionstamp: null,
        },
        { key: countKey, versionstamp: countEntry.versionstamp },
      )
      .set(chatKeys.roomDeletion(room.id), deletion)
      .delete(chatKeys.room(room.id))
      .delete(chatKeys.roomByOwner(room.ownerId, room.id))
      .delete(chatKeys.member(room.id, room.ownerId))
      .delete(chatKeys.roomByMember(room.ownerId, room.id));
    operation = count === 1
      ? operation.delete(countKey)
      : operation.set(countKey, { count: count - 1 } satisfies RoomOwnerCount);
    return (await operation.commit()).ok;
  }

  async finishRoomDeletion(
    deletion: RoomDeletion,
    completedAt: IsoDateTime,
  ): Promise<void> {
    const key = chatKeys.roomDeletion(deletion.roomId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entry = await this.kv.get<RoomDeletion>(key);
      if (!entry.value || !entry.versionstamp) return;
      if (entry.value.completedAt) return;
      const result = await this.kv.atomic()
        .check({ key, versionstamp: entry.versionstamp })
        .set(
          key,
          {
            ...entry.value,
            completedAt,
          } satisfies RoomDeletion,
        )
        .commit();
      if (result.ok) return;
    }
    throw new Error("Could not mark room deletion complete");
  }

  async deleteRoomAssociatedData(roomId: string): Promise<void> {
    const members = this.kv.list<Member>({
      prefix: ["chat", "members", roomId],
    });
    for await (const entry of members) {
      await this.kv.delete(
        chatKeys.roomByMember(entry.value.userId, roomId),
      );
      await this.kv.delete(entry.key);
    }
    await this.#deletePrefix(["chat", "requests", roomId]);
    await this.#deletePrefix(["chat", "messages", roomId]);
    await this.#deletePrefix(["chat", "readPositions", roomId]);

    const notifications = this.kv.list<Notification>({
      prefix: ["chat", "notifications"],
    });
    for await (const entry of notifications) {
      if (entry.value.roomId === roomId) await this.kv.delete(entry.key);
    }
    const events = this.kv.list<ChatEvent>({ prefix: ["chat", "events"] });
    for await (const entry of events) {
      if (entry.value.roomId === roomId) await this.kv.delete(entry.key);
    }
  }

  async getAccountDeletion(userId: string): Promise<AccountDeletion | null> {
    return (
      await this.kv.get<AccountDeletion>(chatKeys.accountDeletion(userId))
    ).value;
  }

  async getAccountDeletionEntry(
    userId: string,
  ): Promise<Deno.KvEntryMaybe<AccountDeletion>> {
    return await this.kv.get<AccountDeletion>(
      chatKeys.accountDeletion(userId),
    );
  }

  async beginAccountDeletion(
    userId: string,
    sessionId: string,
    startedAt: IsoDateTime,
  ): Promise<"started" | "owned-rooms" | "not-found" | "conflict"> {
    const [userEntry, countEntry, deletionEntry] = await Promise.all([
      this.kv.get<User>(chatKeys.user(userId)),
      this.kv.get<RoomOwnerCount>(chatKeys.roomOwnerCount(userId)),
      this.kv.get<AccountDeletion>(chatKeys.accountDeletion(userId)),
    ]);
    if (!userEntry.value || !userEntry.versionstamp) return "not-found";
    if ((countEntry.value?.count ?? 0) > 0) return "owned-rooms";
    if (deletionEntry.value) {
      return deletionEntry.value.sessionId === sessionId
        ? "started"
        : "conflict";
    }
    const result = await this.kv.atomic()
      .check(
        { key: userEntry.key, versionstamp: userEntry.versionstamp },
        { key: countEntry.key, versionstamp: countEntry.versionstamp },
        { key: deletionEntry.key, versionstamp: null },
      )
      .set(
        deletionEntry.key,
        {
          userId,
          sessionId,
          startedAt,
        } satisfies AccountDeletion,
      )
      .commit();
    return result.ok ? "started" : "conflict";
  }

  async deleteAccountAssociatedData(
    userId: string,
    currentSessionId: string,
    email: string,
  ): Promise<void> {
    const memberships = this.kv.list<string>({
      prefix: ["chat", "roomsByMember", userId],
    });
    for await (const entry of memberships) {
      const roomId = entry.value;
      await this.kv.delete(chatKeys.member(roomId, userId));
      await this.kv.delete(chatKeys.request(roomId, userId));
      await this.kv.delete(chatKeys.readPosition(roomId, userId));
      await this.kv.delete(entry.key);
    }
    const requests = this.kv.list<JoinRequest>({
      prefix: ["chat", "requests"],
    });
    for await (const entry of requests) {
      if (entry.value.userId === userId) await this.kv.delete(entry.key);
    }

    const sessions = this.kv.list<Session>({ prefix: ["chat", "sessions"] });
    for await (const entry of sessions) {
      if (
        entry.value.userId === userId &&
        entry.value.id !== currentSessionId
      ) await this.kv.delete(entry.key);
    }

    const notifications = this.kv.list<Notification>({
      prefix: ["chat", "notifications"],
    });
    for await (const entry of notifications) {
      if (
        entry.value.userId === userId || entry.value.actorId === userId
      ) await this.kv.delete(entry.key);
    }
    const events = this.kv.list<ChatEvent>({ prefix: ["chat", "events"] });
    for await (const entry of events) {
      if (
        entry.value.actorId === userId ||
        entry.value.targetUserId === userId
      ) await this.kv.delete(entry.key);
    }

    const positions = this.kv.list<ReadPosition>({
      prefix: ["chat", "readPositions"],
    });
    for await (const entry of positions) {
      if (entry.value.userId === userId) await this.kv.delete(entry.key);
    }
    const roomDeletions = this.kv.list<RoomDeletion>({
      prefix: ["chat", "roomDeletions"],
    });
    for await (const entry of roomDeletions) {
      if (entry.value.ownerId === userId) {
        await this.deleteRoomAssociatedData(entry.value.roomId);
        await this.kv.delete(entry.key);
      }
    }
    const rateLimits = this.kv.list<RateLimitWindow>({
      prefix: ["chat", "rateLimits"],
    });
    for await (const entry of rateLimits) {
      if (
        entry.key.some((part) =>
          part === userId || part === normalizeEmail(email)
        )
      ) await this.kv.delete(entry.key);
    }
  }

  async finishAccountDeletion(
    user: User,
    expectedUserVersionstamp: string,
    deletion: AccountDeletion,
    expectedDeletionVersionstamp: string,
  ): Promise<boolean> {
    const emailEntry = await this.kv.get<string>(
      chatKeys.userByEmail(user.email),
    );
    const countEntry = await this.kv.get<RoomOwnerCount>(
      chatKeys.roomOwnerCount(user.id),
    );
    if ((countEntry.value?.count ?? 0) > 0) return false;
    const operation = this.kv.atomic()
      .check(
        {
          key: chatKeys.user(user.id),
          versionstamp: expectedUserVersionstamp,
        },
        {
          key: chatKeys.accountDeletion(user.id),
          versionstamp: expectedDeletionVersionstamp,
        },
        { key: countEntry.key, versionstamp: countEntry.versionstamp },
        { key: emailEntry.key, versionstamp: emailEntry.versionstamp },
      )
      .delete(chatKeys.user(user.id))
      .delete(chatKeys.userByEmail(user.email))
      .delete(chatKeys.otp(user.email))
      .delete(chatKeys.session(deletion.sessionId))
      .delete(chatKeys.roomOwnerCount(user.id))
      .delete(chatKeys.accountDeletion(user.id));
    return (await operation.commit()).ok;
  }

  async setMember(member: Member): Promise<void> {
    await this.kv.atomic()
      .set(chatKeys.member(member.roomId, member.userId), member)
      .set(chatKeys.roomByMember(member.userId, member.roomId), member.roomId)
      .commit();
  }

  async getMember(roomId: string, userId: string): Promise<Member | null> {
    return (await this.kv.get<Member>(chatKeys.member(roomId, userId))).value;
  }

  async getMemberEntry(
    roomId: string,
    userId: string,
  ): Promise<Deno.KvEntryMaybe<Member>> {
    return await this.kv.get<Member>(chatKeys.member(roomId, userId));
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

  async listMembers(
    roomId: string,
    limit = chatLimits.maxRoomMembers,
  ): Promise<Member[]> {
    const members: Member[] = [];
    const entries = this.kv.list<Member>(
      { prefix: ["chat", "members", roomId] },
      { limit: Math.max(1, Math.floor(limit)) },
    );
    for await (const entry of entries) members.push(entry.value);
    members.sort((left, right) => left.joinedAt.localeCompare(right.joinedAt));
    return members;
  }

  async updateMember(
    member: Member,
    expectedMemberVersionstamp: string,
    expectedRoomVersionstamp: string,
    event?: ChatEventDraft,
  ): Promise<boolean> {
    let operation = this.kv.atomic()
      .check(
        {
          key: chatKeys.room(member.roomId),
          versionstamp: expectedRoomVersionstamp,
        },
        {
          key: chatKeys.member(member.roomId, member.userId),
          versionstamp: expectedMemberVersionstamp,
        },
      )
      .set(chatKeys.member(member.roomId, member.userId), member);
    operation = (await this.#appendEvent(operation, event)).operation;
    const result = await operation.commit();
    return result.ok;
  }

  async removeMember(
    request: JoinRequest,
    expectedRequestVersionstamp: string | null,
    expectedMemberVersionstamp: string,
    expectedRoomVersionstamp: string,
    event?: ChatEventDraft,
  ): Promise<boolean> {
    const memberKey = chatKeys.member(request.roomId, request.userId);
    const memberIndexKey = chatKeys.roomByMember(
      request.userId,
      request.roomId,
    );
    let operation = this.kv.atomic()
      .check(
        {
          key: chatKeys.room(request.roomId),
          versionstamp: expectedRoomVersionstamp,
        },
        {
          key: chatKeys.request(request.roomId, request.userId),
          versionstamp: expectedRequestVersionstamp,
        },
        { key: memberKey, versionstamp: expectedMemberVersionstamp },
      )
      .set(chatKeys.request(request.roomId, request.userId), request)
      .delete(memberKey)
      .delete(memberIndexKey);
    operation = (await this.#appendEvent(operation, event)).operation;
    const result = await operation.commit();
    return result.ok;
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

  async getJoinRequestEntry(
    roomId: string,
    userId: string,
  ): Promise<Deno.KvEntryMaybe<JoinRequest>> {
    return await this.kv.get<JoinRequest>(chatKeys.request(roomId, userId));
  }

  async listJoinRequests(
    roomId: string,
    status?: JoinRequestStatus,
    limit = chatLimits.maxRoomMembers,
  ): Promise<JoinRequest[]> {
    const requests: JoinRequest[] = [];
    const entries = this.kv.list<JoinRequest>(
      { prefix: ["chat", "requests", roomId] },
      { limit: Math.max(1, Math.floor(limit)) },
    );
    for await (const entry of entries) {
      if (!status || entry.value.status === status) requests.push(entry.value);
    }
    requests.sort((left, right) =>
      left.requestedAt.localeCompare(right.requestedAt)
    );
    return requests;
  }

  async replaceJoinRequest(
    request: JoinRequest,
    expectedRequestVersionstamp: string | null,
    expectedMemberVersionstamp: string | null,
    expectedRoomVersionstamp: string,
    event?: ChatEventDraft,
  ): Promise<boolean> {
    let operation = this.kv.atomic()
      .check(
        {
          key: chatKeys.room(request.roomId),
          versionstamp: expectedRoomVersionstamp,
        },
        {
          key: chatKeys.request(request.roomId, request.userId),
          versionstamp: expectedRequestVersionstamp,
        },
        {
          key: chatKeys.member(request.roomId, request.userId),
          versionstamp: expectedMemberVersionstamp,
        },
      )
      .set(chatKeys.request(request.roomId, request.userId), request);
    operation = (await this.#appendEvent(operation, event)).operation;
    const result = await operation.commit();
    return result.ok;
  }

  async claimJoinRequestEmailNotification(
    request: JoinRequest,
    expectedVersionstamp: string,
    notifiedAt: IsoDateTime,
  ): Promise<JoinRequest | null> {
    if (request.emailNotifiedAt !== null) return null;
    const key = chatKeys.request(request.roomId, request.userId);
    const notified: JoinRequest = { ...request, emailNotifiedAt: notifiedAt };
    const result = await this.kv.atomic()
      .check({ key, versionstamp: expectedVersionstamp })
      .set(key, notified)
      .commit();
    return result.ok ? notified : null;
  }

  async approveJoinRequest(
    request: JoinRequest,
    member: Member,
    expectedRequestVersionstamp: string,
    expectedRoomVersionstamp: string,
    event?: ChatEventDraft,
  ): Promise<boolean> {
    const memberKey = chatKeys.member(member.roomId, member.userId);
    const memberIndexKey = chatKeys.roomByMember(member.userId, member.roomId);
    let operation = this.kv.atomic()
      .check(
        {
          key: chatKeys.room(request.roomId),
          versionstamp: expectedRoomVersionstamp,
        },
        {
          key: chatKeys.request(request.roomId, request.userId),
          versionstamp: expectedRequestVersionstamp,
        },
        { key: memberKey, versionstamp: null },
        { key: memberIndexKey, versionstamp: null },
        {
          key: chatKeys.accountDeletion(member.userId),
          versionstamp: null,
        },
      )
      .set(chatKeys.request(request.roomId, request.userId), request)
      .set(memberKey, member)
      .set(memberIndexKey, member.roomId);
    operation = (await this.#appendEvent(operation, event)).operation;
    const result = await operation.commit();
    return result.ok;
  }

  async rejectJoinRequest(
    request: JoinRequest,
    expectedRequestVersionstamp: string,
    expectedRoomVersionstamp: string,
    event?: ChatEventDraft,
  ): Promise<boolean> {
    let operation = this.kv.atomic()
      .check(
        {
          key: chatKeys.room(request.roomId),
          versionstamp: expectedRoomVersionstamp,
        },
        {
          key: chatKeys.request(request.roomId, request.userId),
          versionstamp: expectedRequestVersionstamp,
        },
        {
          key: chatKeys.member(request.roomId, request.userId),
          versionstamp: null,
        },
      )
      .set(chatKeys.request(request.roomId, request.userId), request);
    operation = (await this.#appendEvent(operation, event)).operation;
    const result = await operation.commit();
    return result.ok;
  }

  async setMessage(message: Message): Promise<void> {
    await this.kv.set(chatKeys.message(message.roomId, message.id), message);
  }

  async createMessage(
    message: Message,
    expectedRoomVersionstamp: string,
    expectedMemberVersionstamp: string,
    event?: ChatEventDraft,
  ): Promise<boolean> {
    const messageKey = chatKeys.message(message.roomId, message.id);
    let operation = this.kv.atomic()
      .check(
        {
          key: chatKeys.room(message.roomId),
          versionstamp: expectedRoomVersionstamp,
        },
        {
          key: chatKeys.member(message.roomId, message.authorId),
          versionstamp: expectedMemberVersionstamp,
        },
        { key: messageKey, versionstamp: null },
      )
      .set(messageKey, message);
    operation = (await this.#appendEvent(operation, event)).operation;
    const result = await operation.commit();
    return result.ok;
  }

  async getMessage(roomId: string, messageId: string): Promise<Message | null> {
    return (await this.kv.get<Message>(chatKeys.message(roomId, messageId)))
      .value;
  }

  async getMessageEntry(
    roomId: string,
    messageId: string,
  ): Promise<Deno.KvEntryMaybe<Message>> {
    return await this.kv.get<Message>(chatKeys.message(roomId, messageId));
  }

  async redactMessage(
    message: Message,
    actorId: string,
    expectedMessageVersionstamp: string,
    expectedRoomVersionstamp: string,
    expectedMemberVersionstamp: string,
    event?: ChatEventDraft,
  ): Promise<boolean> {
    let operation = this.kv.atomic()
      .check(
        {
          key: chatKeys.room(message.roomId),
          versionstamp: expectedRoomVersionstamp,
        },
        {
          key: chatKeys.member(message.roomId, actorId),
          versionstamp: expectedMemberVersionstamp,
        },
        {
          key: chatKeys.message(message.roomId, message.id),
          versionstamp: expectedMessageVersionstamp,
        },
      )
      .set(chatKeys.message(message.roomId, message.id), message);
    operation = (await this.#appendEvent(operation, event)).operation;
    const result = await operation.commit();
    return result.ok;
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

    const limit = pageSize(options.limit);
    const candidates: Message[] = [];
    const entries = this.kv.list<Message>(selector, {
      limit: limit + 1,
      reverse: true,
    });
    for await (const entry of entries) {
      if (
        !options.visibleFrom ||
        entry.value.createdAt >= options.visibleFrom
      ) {
        candidates.push(entry.value);
      }
    }
    const hasMore = candidates.length > limit;
    const messages = candidates.slice(0, limit);
    return {
      messages,
      nextBefore: hasMore ? messages.at(-1)?.id ?? null : null,
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

  async advanceReadPosition(position: ReadPosition): Promise<ReadPosition> {
    const key = chatKeys.readPosition(position.roomId, position.userId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const entry = await this.kv.get<ReadPosition>(key);
      const current = entry.value;
      // A stale browser tab must never move the marker backwards and make
      // messages unread again.
      if (
        current?.lastReadMessageId && position.lastReadMessageId &&
        current.lastReadMessageId >= position.lastReadMessageId
      ) {
        return current;
      }
      const result = await this.kv.atomic()
        .check({ key, versionstamp: entry.versionstamp })
        .set(key, position)
        .commit();
      if (result.ok) return position;
    }
    return (await this.getReadPosition(position.roomId, position.userId)) ??
      position;
  }

  async countUnreadMessages(
    roomId: string,
    userId: string,
    visibleFrom: IsoDateTime,
    lastReadMessageId: string | null,
  ): Promise<number> {
    const messages = this.kv.list<Message>({
      start: ["chat", "messages", roomId, sortableIdLowerBound(visibleFrom)],
      end: ["chat", "messages", roomId, "\uffff"],
    });
    let count = 0;
    for await (const entry of messages) {
      const message = entry.value;
      if (
        message.createdAt >= visibleFrom &&
        (!lastReadMessageId || message.id > lastReadMessageId) &&
        message.authorId !== userId
      ) count += 1;
    }
    return count;
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

  async listEventsAfter(
    eventId: string,
    limit = chatLimits.maxPageSize,
  ): Promise<ChatEvent[]> {
    const events: ChatEvent[] = [];
    const entries = this.kv.list<ChatEvent>({
      prefix: ["chat", "events"],
      start: chatKeys.event(eventId),
    }, { limit: Math.max(1, Math.floor(limit)) + 1 });
    for await (const entry of entries) {
      if (entry.value.id > eventId) events.push(entry.value);
      if (events.length >= limit) break;
    }
    return events;
  }

  async getLatestEventId(): Promise<string> {
    const sequence = (await this.kv.get<Deno.KvU64>(
      chatKeys.eventSequence(),
    )).value?.value ?? 0n;
    return sequence.toString().padStart(20, "0");
  }

  async #appendEvent(
    operation: Deno.AtomicOperation,
    event?: ChatEventDraft,
  ): Promise<{ operation: Deno.AtomicOperation }> {
    if (!event) return { operation };
    const sequenceKey = chatKeys.eventSequence();
    const sequenceEntry = await this.kv.get<Deno.KvU64>(sequenceKey);
    const current = sequenceEntry.value?.value ?? 0n;
    const next = current + 1n;
    if (next > 99_999_999_999_999_999_999n) {
      throw new RangeError("Chat event sequence is exhausted");
    }
    const persisted: ChatEvent = {
      ...event,
      id: next.toString().padStart(20, "0"),
    };
    return {
      operation: operation
        .check({ key: sequenceKey, versionstamp: sequenceEntry.versionstamp })
        .set(sequenceKey, new Deno.KvU64(next))
        .check({ key: chatKeys.event(persisted.id), versionstamp: null })
        .set(chatKeys.event(persisted.id), persisted),
    };
  }

  async #deletePrefix(prefix: Deno.KvKey): Promise<void> {
    const entries = this.kv.list({ prefix });
    for await (const entry of entries) await this.kv.delete(entry.key);
  }
}
