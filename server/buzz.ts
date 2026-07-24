import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { decode, npubEncode } from "nostr-tools/nip19";
import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate
} from "nostr-tools/pure";

export type BuildPlatform = "native mobile" | "webapp" | "desktop app" | "cross-platform";
export type BuildDifficulty = "weekend" | "one-week" | "multi-week";

export interface BuildIdea {
  rank: number;
  name: string;
  tagline: string;
  platform: BuildPlatform;
  targetUser: string;
  concept: string;
  viralHook: string;
  buildScope: string;
  difficulty: BuildDifficulty;
}

export interface BuildableIdea extends BuildIdea {
  buildToken: string;
}

export interface BuildOnBuzzRequest {
  idea: BuildableIdea;
  requestId: string;
  relayAuthorization: NostrEvent;
  agentCommand?: SignedAgentCommand;
}

export interface SignedAgentCommand {
  agentPubkey: string;
  addEvent: NostrEvent;
  addEventBody: string;
  addRelayAuthorization: NostrEvent;
  commandEvent: NostrEvent;
  commandEventBody: string;
  commandRelayAuthorization: NostrEvent;
}

export interface VerifiedBuildRequest {
  authorizationId: string;
  request: BuildOnBuzzRequest;
  userPubkey: string;
}

export interface BuzzBuildConfig {
  channelCreatorNsec: string;
  expectedCreatorPubkey?: string;
  publicOrigin: string;
  relayHttpUrl: string;
  generalChannelId: string;
}

export interface BuildChannelResult {
  channelId: string;
  channelName: string;
  creatorPubkey: string;
  messageEventId: string;
  agentMessageEventId?: string;
  announcementEventId: string;
}

interface RelayWriteResponse {
  accepted?: boolean;
  event_id?: string;
  message?: string;
}

const NIP98_KIND = 27235;
const BOT_COMMAND = "build the idea described above. one shot, make no mistakes.";
const AUTH_MAX_AGE_SECONDS = 120;
const AUTH_MAX_FUTURE_SECONDS = 30;
const RELAY_TIMEOUT_MS = 12_000;
const MAX_FIELD_LENGTHS: Record<keyof Omit<BuildIdea, "rank">, number> = {
  name: 80,
  tagline: 180,
  platform: 32,
  targetUser: 180,
  concept: 420,
  viralHook: 240,
  buildScope: 240,
  difficulty: 32
};
const platforms = new Set<BuildPlatform>([
  "native mobile",
  "webapp",
  "desktop app",
  "cross-platform"
]);
const difficulties = new Set<BuildDifficulty>(["weekend", "one-week", "multi-week"]);

export class BuildOnBuzzError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    internalMessage = publicMessage
  ) {
    super(internalMessage);
  }
}

export class AuthorizationReplayGuard {
  private readonly used = new Map<string, number>();

  consume(eventId: string, nowSeconds = Math.floor(Date.now() / 1000)) {
    for (const [id, expiresAt] of this.used) {
      if (expiresAt <= nowSeconds) {
        this.used.delete(id);
      }
    }

    if (this.used.has(eventId)) {
      throw new BuildOnBuzzError(409, "This build authorization was already used. Please try again.");
    }

    this.used.set(eventId, nowSeconds + AUTH_MAX_AGE_SECONDS);
  }
}

export class BuildRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts = 3,
    private readonly windowSeconds = 10 * 60
  ) {}

  consume(pubkey: string, nowSeconds = Math.floor(Date.now() / 1000)) {
    const cutoff = nowSeconds - this.windowSeconds;
    const recent = (this.attempts.get(pubkey) ?? []).filter((timestamp) => timestamp > cutoff);

    if (recent.length >= this.maxAttempts) {
      throw new BuildOnBuzzError(
        429,
        "Too many Buzz build rooms were created recently. Please try again in a few minutes."
      );
    }

    recent.push(nowSeconds);
    this.attempts.set(pubkey, recent);
  }
}

export function normalizeRelayHttpUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("wss://")) return `https://${trimmed.slice(6)}`;
  if (trimmed.startsWith("ws://")) return `http://${trimmed.slice(5)}`;
  return trimmed;
}

export function relayMembershipQueryBody(pubkey: string) {
  return JSON.stringify([{ kinds: [0], authors: [pubkey], limit: 1 }]);
}

export function verifyBuildRequest(
  authorizationHeader: string | undefined,
  rawBody: Buffer,
  config: Pick<
    BuzzBuildConfig,
    "channelCreatorNsec" | "publicOrigin" | "relayHttpUrl"
  >,
  nowSeconds = Math.floor(Date.now() / 1000)
): VerifiedBuildRequest {
  const authorization = decodeAuthorizationHeader(authorizationHeader);
  const request = parseBuildRequest(rawBody);
  const relayHttpUrl = normalizeRelayHttpUrl(config.relayHttpUrl);
  const publicOrigin = config.publicOrigin.trim().replace(/\/+$/, "");

  verifyNip98Event(authorization, {
    body: rawBody,
    method: "POST",
    nowSeconds,
    url: `${publicOrigin}/api/build-on-buzz`
  });

  const relayBody = Buffer.from(relayMembershipQueryBody(authorization.pubkey));
  verifyNip98Event(request.relayAuthorization, {
    body: relayBody,
    method: "POST",
    nowSeconds,
    url: `${relayHttpUrl}/query`
  });

  if (request.relayAuthorization.pubkey !== authorization.pubkey) {
    throw new BuildOnBuzzError(401, "The Flint authorization does not match this nsec.");
  }

  if (request.agentCommand) {
    verifyAgentCommand(
      request.agentCommand,
      authorization.pubkey,
      request.requestId,
      relayHttpUrl,
      nowSeconds
    );
  }

  if (!verifyBuildToken(request.idea, config.channelCreatorNsec)) {
    throw new BuildOnBuzzError(
      401,
      "This idea is not authorized for building. Generate a fresh set of ideas and try again."
    );
  }

  return {
    authorizationId: authorization.id,
    request,
    userPubkey: authorization.pubkey
  };
}

export async function confirmFlintMembership(
  verified: VerifiedBuildRequest,
  relayHttpUrl: string,
  fetchImpl: typeof fetch = fetch
) {
  const relayBase = normalizeRelayHttpUrl(relayHttpUrl);
  const body = relayMembershipQueryBody(verified.userPubkey);
  const response = await fetchImpl(`${relayBase}/query`, {
    method: "POST",
    headers: {
      Authorization: encodeAuthorizationHeader(verified.request.relayAuthorization),
      "Content-Type": "application/json"
    },
    body,
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS)
  });

  if (response.status === 401 || response.status === 403) {
    throw new BuildOnBuzzError(
      403,
      "That nsec is valid, but it is not authorized for the Flint Buzz community."
    );
  }

  if (!response.ok) {
    throw new BuildOnBuzzError(
      502,
      "Flint could not verify this identity right now. Please try again.",
      `Flint membership query failed with HTTP ${response.status}`
    );
  }
}

export async function createBuildChannel(
  verified: VerifiedBuildRequest,
  config: BuzzBuildConfig,
  fetchImpl: typeof fetch = fetch
): Promise<BuildChannelResult> {
  const relayBase = normalizeRelayHttpUrl(config.relayHttpUrl);
  const serviceKey = decodePrivateKey(config.channelCreatorNsec);
  let channelCreated = false;
  const channelId = verified.request.requestId;
  const channelName = buildChannelName(verified.request.idea.name, channelId);
  const creatorPubkey = getPublicKey(serviceKey);
  const agentCommand = verified.request.agentCommand;

  try {
    const expectedCreator = config.expectedCreatorPubkey?.trim().toLowerCase();
    if (expectedCreator && creatorPubkey !== expectedCreator) {
      throw new BuildOnBuzzError(
        503,
        "Buzz channel creation is not configured correctly yet.",
        "Configured Buzz channel creator key does not match the expected pubkey"
      );
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        config.generalChannelId
      )
    ) {
      throw new BuildOnBuzzError(
        503,
        "Buzz channel creation is not configured correctly yet.",
        "BUZZ_GENERAL_CHANNEL_ID is missing or invalid"
      );
    }

    await submitRelayEvent(
      {
        kind: 9007,
        content: "",
        tags: [
          ["h", channelId],
          ["name", channelName],
          ["visibility", "open"],
          ["channel_type", "stream"],
          ["about", `Build room created from Brainstorm City for ${verified.request.idea.name}.`]
        ]
      },
      serviceKey,
      relayBase,
      fetchImpl
    );
    channelCreated = true;

    if (verified.userPubkey !== creatorPubkey) {
      await submitRelayEvent(
        {
          kind: 9000,
          content: "",
          tags: [
            ["h", channelId],
            ["p", verified.userPubkey]
          ]
        },
        serviceKey,
        relayBase,
        fetchImpl
      );
    }

    if (agentCommand && agentCommand.agentPubkey !== creatorPubkey) {
      await submitSignedRelayEvent(
        agentCommand.addEventBody,
        agentCommand.addRelayAuthorization,
        relayBase,
        fetchImpl,
        "Buzz could not add that build agent. Check its pubkey or channel-add policy and try again.",
        "Relay user-signed agent add"
      );
    }

    const displayName = await lookupDisplayName(
      verified.userPubkey,
      serviceKey,
      relayBase,
      fetchImpl
    ).catch(() => null);
    const mention = displayName
      ? `@${displayName}`
      : `nostr:${npubEncode(verified.userPubkey)}`;
    const message = formatBuildKickoff(
      verified.request.idea,
      mention,
      Boolean(agentCommand)
    );
    const messageResponse = await submitRelayEvent(
      {
        kind: 9,
        content: message,
        tags: [
          ["h", channelId],
          ["p", verified.userPubkey]
        ]
      },
      serviceKey,
      relayBase,
      fetchImpl
    );

    const agentMessageResponse = agentCommand
      ? await submitSignedRelayEvent(
          agentCommand.commandEventBody,
          agentCommand.commandRelayAuthorization,
          relayBase,
          fetchImpl,
          "Buzz could not deliver the signed build-agent command. Please try again.",
          "Relay user command"
        )
      : undefined;
    const announcementResponse = await submitRelayEvent(
      {
        kind: 9,
        content: formatGeneralAnnouncement(
          verified.request.idea,
          channelName,
          channelId,
          messageResponse.event_id ?? ""
        ),
        tags: [["h", config.generalChannelId]]
      },
      serviceKey,
      relayBase,
      fetchImpl
    );

    return {
      channelId,
      channelName,
      creatorPubkey,
      messageEventId: messageResponse.event_id ?? "",
      ...(agentMessageResponse?.event_id
        ? { agentMessageEventId: agentMessageResponse.event_id }
        : {}),
      announcementEventId: announcementResponse.event_id ?? ""
    };
  } catch (caught) {
    if (channelCreated) {
      await submitRelayEvent(
        {
          kind: 9008,
          content: "",
          tags: [["h", channelId]]
        },
        serviceKey,
        relayBase,
        fetchImpl
      ).catch(() => undefined);
    }
    throw caught;
  } finally {
    serviceKey.fill(0);
  }
}

export function formatBuildKickoff(idea: BuildIdea, mention: string, hasAgent = false) {
  return [
    `# Build brief: ${idea.name}`,
    "",
    idea.tagline,
    "",
    idea.concept,
    "",
    `Brainstorm City rank: #${idea.rank}`,
    `Platform: ${idea.platform}`,
    `Audience: ${idea.targetUser}`,
    `Hook: ${idea.viralHook}`,
    `MVP: ${idea.buildScope}`,
    `Difficulty: ${idea.difficulty}`,
    "",
    hasAgent
      ? `${mention}, your selected build agent has been added and will receive your one-shot build command next.`
      : `${mention}, add your favorite agent to this channel and ask them to build it. Share the repository and any constraints, then let the agent take the first implementation shift.`
  ].join("\n");
}

export function formatAgentCommand(agentPubkey: string) {
  return `nostr:${npubEncode(agentPubkey)} ${BOT_COMMAND}`;
}

export function formatGeneralAnnouncement(
  idea: BuildIdea,
  channelName: string,
  channelId: string,
  messageEventId: string
) {
  return [
    `A new Brainstorm City build is live: **${idea.name}**`,
    "",
    `[Open #${channelName}](buzz://message?channel=${channelId}&id=${messageEventId})`
  ].join("\n");
}

export function addBuildToken(idea: BuildIdea, channelCreatorNsec: string): BuildableIdea {
  return {
    ...idea,
    buildToken: channelCreatorNsec ? buildTokenForIdea(idea, channelCreatorNsec) : ""
  };
}

function parseBuildRequest(rawBody: Buffer): BuildOnBuzzRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new BuildOnBuzzError(400, "The build request was not valid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new BuildOnBuzzError(400, "The build request is missing.");
  }

  const record = parsed as Record<string, unknown>;
  const requestId = stringValue(record.requestId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new BuildOnBuzzError(400, "The build request ID is invalid.");
  }

  return {
    idea: parseIdea(record.idea),
    requestId,
    relayAuthorization: parseNostrEvent(record.relayAuthorization, "The Flint authorization is invalid."),
    ...(record.agentCommand === undefined
      ? {}
      : { agentCommand: parseAgentCommand(record.agentCommand) })
  };
}

function parseAgentCommand(value: unknown): SignedAgentCommand {
  if (!value || typeof value !== "object") {
    throw new BuildOnBuzzError(400, "The build agent command is invalid.");
  }

  const record = value as Record<string, unknown>;
  const agentPubkey = stringValue(record.agentPubkey).toLowerCase();
  const addEventBody =
    typeof record.addEventBody === "string" ? record.addEventBody : "";
  const commandEventBody =
    typeof record.commandEventBody === "string" ? record.commandEventBody : "";
  if (
    !/^[0-9a-f]{64}$/.test(agentPubkey) ||
    !addEventBody ||
    addEventBody.length > 12_000 ||
    !commandEventBody ||
    commandEventBody.length > 12_000
  ) {
    throw new BuildOnBuzzError(400, "The build agent pubkey or command is invalid.");
  }

  let addEventValue: unknown;
  let commandEventValue: unknown;
  try {
    addEventValue = JSON.parse(addEventBody);
    commandEventValue = JSON.parse(commandEventBody);
  } catch {
    throw new BuildOnBuzzError(400, "The signed build agent handoff is invalid.");
  }

  return {
    agentPubkey,
    addEvent: parseNostrEvent(addEventValue, "The signed build agent addition is invalid."),
    addEventBody,
    addRelayAuthorization: parseNostrEvent(
      record.addRelayAuthorization,
      "The build agent addition authorization is invalid."
    ),
    commandEvent: parseNostrEvent(
      commandEventValue,
      "The signed build agent command is invalid."
    ),
    commandEventBody,
    commandRelayAuthorization: parseNostrEvent(
      record.commandRelayAuthorization,
      "The build agent relay authorization is invalid."
    )
  };
}

function parseIdea(value: unknown): BuildableIdea {
  if (!value || typeof value !== "object") {
    throw new BuildOnBuzzError(400, "The selected idea is missing.");
  }

  const record = value as Record<string, unknown>;
  const rank = Number(record.rank);
  if (!Number.isInteger(rank) || rank < 1 || rank > 99) {
    throw new BuildOnBuzzError(400, "The selected idea rank is invalid.");
  }

  const idea = {
    rank,
    name: ideaField(record, "name"),
    tagline: ideaField(record, "tagline"),
    platform: ideaField(record, "platform") as BuildPlatform,
    targetUser: ideaField(record, "targetUser"),
    concept: ideaField(record, "concept"),
    viralHook: ideaField(record, "viralHook"),
    buildScope: ideaField(record, "buildScope"),
    difficulty: ideaField(record, "difficulty") as BuildDifficulty,
    buildToken: stringValue(record.buildToken).toLowerCase()
  };

  if (!platforms.has(idea.platform) || !difficulties.has(idea.difficulty)) {
    throw new BuildOnBuzzError(400, "The selected idea contains an invalid option.");
  }
  if (!/^[0-9a-f]{64}$/.test(idea.buildToken)) {
    throw new BuildOnBuzzError(401, "This idea is missing its build authorization.");
  }

  return idea;
}

function verifyBuildToken(idea: BuildableIdea, channelCreatorNsec: string) {
  const expected = Buffer.from(buildTokenForIdea(idea, channelCreatorNsec), "hex");
  const received = Buffer.from(idea.buildToken, "hex");
  return expected.byteLength === received.byteLength && timingSafeEqual(expected, received);
}

function buildTokenForIdea(idea: BuildIdea, channelCreatorNsec: string) {
  const canonical = JSON.stringify({
    rank: idea.rank,
    name: idea.name,
    tagline: idea.tagline,
    platform: idea.platform,
    targetUser: idea.targetUser,
    concept: idea.concept,
    viralHook: idea.viralHook,
    buildScope: idea.buildScope,
    difficulty: idea.difficulty
  });
  return createHmac("sha256", channelCreatorNsec).update(canonical).digest("hex");
}

function ideaField(record: Record<string, unknown>, field: keyof Omit<BuildIdea, "rank">) {
  const value = stringValue(record[field]).normalize("NFKC").replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  if (!value || value.length > MAX_FIELD_LENGTHS[field]) {
    throw new BuildOnBuzzError(400, `The selected idea ${field} is invalid.`);
  }
  return value;
}

function decodeAuthorizationHeader(header: string | undefined) {
  if (!header || header.length > 12_000 || !header.startsWith("Nostr ")) {
    throw new BuildOnBuzzError(401, "Enter a valid nsec for the Flint Buzz community.");
  }

  try {
    const json = Buffer.from(header.slice(6), "base64").toString("utf8");
    return parseNostrEvent(JSON.parse(json), "The build authorization is invalid.");
  } catch (caught) {
    if (caught instanceof BuildOnBuzzError) throw caught;
    throw new BuildOnBuzzError(401, "The build authorization is invalid.");
  }
}

function parseNostrEvent(value: unknown, message: string): NostrEvent {
  if (!value || typeof value !== "object") {
    throw new BuildOnBuzzError(401, message);
  }

  const event = value as NostrEvent;
  if (!verifyEvent(event)) {
    throw new BuildOnBuzzError(401, message);
  }
  return event;
}

function verifyNip98Event(
  event: NostrEvent,
  expected: { body: Buffer; method: string; nowSeconds: number; url: string }
) {
  if (event.kind !== NIP98_KIND) {
    throw new BuildOnBuzzError(401, "The signed authorization has the wrong event kind.");
  }

  const age = expected.nowSeconds - event.created_at;
  if (age > AUTH_MAX_AGE_SECONDS || age < -AUTH_MAX_FUTURE_SECONDS) {
    throw new BuildOnBuzzError(401, "The signed authorization expired. Please try again.");
  }

  if (
    singleTagValue(event, "u") !== expected.url ||
    singleTagValue(event, "method") !== expected.method ||
    singleTagValue(event, "payload") !== sha256Hex(expected.body)
  ) {
    throw new BuildOnBuzzError(401, "The signed authorization does not match this build request.");
  }

  const nonce = singleTagValue(event, "nonce");
  if (!nonce || nonce.length > 100) {
    throw new BuildOnBuzzError(401, "The signed authorization is missing its nonce.");
  }
}

function verifyAgentCommand(
  command: SignedAgentCommand,
  userPubkey: string,
  channelId: string,
  relayHttpUrl: string,
  nowSeconds: number
) {
  if (command.agentPubkey === userPubkey) {
    throw new BuildOnBuzzError(400, "The build agent pubkey must be different from your pubkey.");
  }
  verifyExactAgentEvent(
    command.addEvent,
    userPubkey,
    channelId,
    command.agentPubkey,
    9000,
    "",
    nowSeconds,
    "addition"
  );
  verifyExactAgentEvent(
    command.commandEvent,
    userPubkey,
    channelId,
    command.agentPubkey,
    9,
    formatAgentCommand(command.agentPubkey),
    nowSeconds,
    "command"
  );
  verifyAgentRelayAuthorization(
    command.addRelayAuthorization,
    userPubkey,
    command.addEventBody,
    relayHttpUrl,
    nowSeconds,
    "addition"
  );
  verifyAgentRelayAuthorization(
    command.commandRelayAuthorization,
    userPubkey,
    command.commandEventBody,
    relayHttpUrl,
    nowSeconds,
    "command"
  );
}

function verifyExactAgentEvent(
  event: NostrEvent,
  userPubkey: string,
  channelId: string,
  agentPubkey: string,
  kind: number,
  content: string,
  nowSeconds: number,
  label: string
) {
  if (
    event.pubkey !== userPubkey ||
    event.kind !== kind ||
    event.content !== content ||
    event.tags.length !== 2 ||
    event.tags[0]?.length !== 2 ||
    event.tags[0]?.[0] !== "h" ||
    event.tags[0]?.[1] !== channelId ||
    event.tags[1]?.length !== 2 ||
    event.tags[1]?.[0] !== "p" ||
    event.tags[1]?.[1] !== agentPubkey
  ) {
    throw new BuildOnBuzzError(
      401,
      `The signed build agent ${label} does not match this room.`
    );
  }

  const age = nowSeconds - event.created_at;
  if (age > AUTH_MAX_AGE_SECONDS || age < -AUTH_MAX_FUTURE_SECONDS) {
    throw new BuildOnBuzzError(
      401,
      `The signed build agent ${label} expired. Please try again.`
    );
  }
}

function verifyAgentRelayAuthorization(
  authorization: NostrEvent,
  userPubkey: string,
  eventBody: string,
  relayHttpUrl: string,
  nowSeconds: number,
  label: string
) {
  if (authorization.pubkey !== userPubkey) {
    throw new BuildOnBuzzError(
      401,
      `The build agent ${label} authorization does not match this nsec.`
    );
  }

  verifyNip98Event(authorization, {
    body: Buffer.from(eventBody),
    method: "POST",
    nowSeconds,
    url: `${relayHttpUrl}/events`
  });
}

function singleTagValue(event: NostrEvent, name: string) {
  const matches = event.tags.filter((tag) => tag[0] === name && typeof tag[1] === "string");
  return matches.length === 1 ? matches[0][1] : undefined;
}

function encodeAuthorizationHeader(event: NostrEvent) {
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

async function submitRelayEvent(
  template: Omit<EventTemplate, "created_at">,
  secretKey: Uint8Array,
  relayBase: string,
  fetchImpl: typeof fetch
) {
  const event = finalizeEvent(
    {
      ...template,
      created_at: Math.floor(Date.now() / 1000)
    },
    secretKey
  );
  const body = JSON.stringify(event);
  const url = `${relayBase}/events`;
  const authorization = signNip98(secretKey, "POST", url, Buffer.from(body));
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: encodeAuthorizationHeader(authorization),
      "Content-Type": "application/json"
    },
    body,
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS)
  });
  const result = (await response.json().catch(() => ({}))) as RelayWriteResponse;

  if (!response.ok || result.accepted !== true) {
    throw new BuildOnBuzzError(
      response.status === 401 || response.status === 403 ? 503 : 502,
      "Buzz could not create this build room right now. Please try again.",
      `Relay event ${template.kind} failed with HTTP ${response.status}: ${result.message ?? "rejected"}`
    );
  }

  return {
    ...result,
    event_id: result.event_id ?? event.id
  };
}

async function submitSignedRelayEvent(
  eventBody: string,
  relayAuthorization: NostrEvent,
  relayBase: string,
  fetchImpl: typeof fetch,
  publicMessage: string,
  internalLabel: string
) {
  const response = await fetchImpl(`${relayBase}/events`, {
    method: "POST",
    headers: {
      Authorization: encodeAuthorizationHeader(relayAuthorization),
      "Content-Type": "application/json"
    },
    body: eventBody,
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS)
  });
  const result = (await response.json().catch(() => ({}))) as RelayWriteResponse;

  if (!response.ok || result.accepted !== true) {
    throw new BuildOnBuzzError(
      response.status === 401 || response.status === 403 ? 403 : 502,
      publicMessage,
      `${internalLabel} failed with HTTP ${response.status}: ${result.message ?? "rejected"}`
    );
  }

  const event = JSON.parse(eventBody) as NostrEvent;
  return {
    ...result,
    event_id: result.event_id ?? event.id
  };
}

async function lookupDisplayName(
  pubkey: string,
  serviceKey: Uint8Array,
  relayBase: string,
  fetchImpl: typeof fetch
) {
  const body = JSON.stringify([{ kinds: [0], authors: [pubkey], limit: 1 }]);
  const url = `${relayBase}/query`;
  const authorization = signNip98(serviceKey, "POST", url, Buffer.from(body));
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: encodeAuthorizationHeader(authorization),
      "Content-Type": "application/json"
    },
    body,
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS)
  });

  if (!response.ok) return null;
  const events = (await response.json()) as NostrEvent[];
  const profile = events[0];
  if (!profile || profile.kind !== 0) return null;

  const content = JSON.parse(profile.content) as Record<string, unknown>;
  const displayName = stringValue(content.display_name) || stringValue(content.name);
  return displayName ? displayName.replace(/[@\r\n]/g, "").slice(0, 80) : null;
}

function signNip98(secretKey: Uint8Array, method: string, url: string, body: Buffer) {
  return finalizeEvent(
    {
      kind: NIP98_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["u", url],
        ["method", method],
        ["payload", sha256Hex(body)],
        ["nonce", randomUUID()]
      ]
    },
    secretKey
  );
}

function decodePrivateKey(value: string) {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, "hex"));
  }

  try {
    const decoded = decode(trimmed);
    if (decoded.type === "nsec") {
      return Uint8Array.from(decoded.data);
    }
  } catch {
    // Fall through to the configuration error below.
  }

  throw new BuildOnBuzzError(
    503,
    "Buzz channel creation is not configured yet.",
    "BUZZ_CHANNEL_CREATOR_NSEC is missing or invalid"
  );
}

function buildChannelName(ideaName: string, requestId: string) {
  const slug =
    ideaName
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "idea";
  return `build-${slug}-${requestId.slice(0, 8)}`;
}

function sha256Hex(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
