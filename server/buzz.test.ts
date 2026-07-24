import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event as NostrEvent
} from "nostr-tools/pure";

import {
  AuthorizationReplayGuard,
  BuildOnBuzzError,
  BuildRateLimiter,
  addBuildToken,
  confirmFlintMembership,
  createBuildChannel,
  formatAgentCommand,
  formatBuildKickoff,
  formatGeneralAnnouncement,
  relayMembershipQueryBody,
  verifyBuildRequest,
  type BuildIdea,
  type VerifiedBuildRequest
} from "./buzz.js";

const nowSeconds = 1_800_000_000;
const publicOrigin = "https://brainstorm-city.example";
const relayHttpUrl = "https://flint.example";
const generalChannelId = "0683e2de-c0c9-496d-bb1f-46d679e3bf38";
const tokenSecret = "test-channel-creator-secret";
const idea: BuildIdea = {
  rank: 1,
  name: "PermitPatch",
  tagline: "Make permit paperwork move",
  platform: "webapp",
  targetUser: "Small construction teams",
  concept: "A shared permit checklist that keeps every approval and document moving.",
  viralHook: "Share a clean public progress board with clients.",
  buildScope: "Permit templates, status tracking, reminders, and a client link.",
  difficulty: "one-week"
};

test("verifies app and Flint NIP-98 authorizations without receiving the nsec", async () => {
  const signed = await signedRequest();
  const verified = verifyBuildRequest(
    signed.authorizationHeader,
    signed.rawBody,
    { channelCreatorNsec: tokenSecret, publicOrigin, relayHttpUrl },
    nowSeconds
  );

  assert.equal(verified.userPubkey, signed.pubkey);
  assert.equal(verified.request.idea.name, idea.name);
  assert.equal(verified.request.requestId, signed.requestId);
});

test("verifies an optional user-signed agent command bound to the new room", async () => {
  const agentPubkey = getPublicKey(generateSecretKey());
  const signed = await signedRequest({ agentPubkey });
  const verified = verifyBuildRequest(
    signed.authorizationHeader,
    signed.rawBody,
    { channelCreatorNsec: tokenSecret, publicOrigin, relayHttpUrl },
    nowSeconds
  );

  assert.equal(verified.request.agentCommand?.agentPubkey, agentPubkey);
  assert.equal(verified.request.agentCommand?.addEvent.pubkey, signed.pubkey);
  assert.equal(verified.request.agentCommand?.addEvent.kind, 9000);
  assert.equal(verified.request.agentCommand?.commandEvent.pubkey, signed.pubkey);
  assert.equal(
    verified.request.agentCommand?.commandEvent.content,
    formatAgentCommand(agentPubkey)
  );
});

test("rejects an agent command signed for a different room", async () => {
  const signed = await signedRequest({
    agentPubkey: getPublicKey(generateSecretKey()),
    commandChannelId: "f0fbde0b-5d2a-4a58-a665-ef9ba76d382f"
  });

  assert.throws(
    () =>
      verifyBuildRequest(
        signed.authorizationHeader,
        signed.rawBody,
        { channelCreatorNsec: tokenSecret, publicOrigin, relayHttpUrl },
        nowSeconds
      ),
    (error: unknown) =>
      error instanceof BuildOnBuzzError &&
      error.publicMessage.includes("does not match this room")
  );
});

test("rejects an idea body changed after authorization", async () => {
  const signed = await signedRequest();
  const tampered = Buffer.from(
    signed.rawBody.toString("utf8").replace("PermitPatch", "PermitPwned")
  );

  assert.throws(
    () =>
      verifyBuildRequest(
        signed.authorizationHeader,
        tampered,
        { channelCreatorNsec: tokenSecret, publicOrigin, relayHttpUrl },
        nowSeconds
      ),
    (error: unknown) => error instanceof BuildOnBuzzError && error.status === 401
  );
});

test("rejects a correctly signed request when the generated idea token was altered", async () => {
  const signed = await signedRequest({
    requestIdea: { ...idea, name: "PermitPwned" },
    tokenIdea: idea
  });

  assert.throws(
    () =>
      verifyBuildRequest(
        signed.authorizationHeader,
        signed.rawBody,
        { channelCreatorNsec: tokenSecret, publicOrigin, relayHttpUrl },
        nowSeconds
      ),
    (error: unknown) =>
      error instanceof BuildOnBuzzError &&
      error.publicMessage.includes("not authorized")
  );
});

test("rejects a Flint authorization signed by a different identity", async () => {
  const signed = await signedRequest({ relaySecretKey: generateSecretKey() });

  assert.throws(
    () =>
      verifyBuildRequest(
        signed.authorizationHeader,
        signed.rawBody,
        { channelCreatorNsec: tokenSecret, publicOrigin, relayHttpUrl },
        nowSeconds
      ),
    (error: unknown) =>
      error instanceof BuildOnBuzzError &&
      error.publicMessage.includes("does not match")
  );
});

test("rejects expired authorizations", async () => {
  const signed = await signedRequest({ createdAt: nowSeconds - 121 });

  assert.throws(
    () =>
      verifyBuildRequest(
        signed.authorizationHeader,
        signed.rawBody,
        { channelCreatorNsec: tokenSecret, publicOrigin, relayHttpUrl },
        nowSeconds
      ),
    (error: unknown) =>
      error instanceof BuildOnBuzzError && error.publicMessage.includes("expired")
  );
});

test("replay guard consumes an authorization once", () => {
  const guard = new AuthorizationReplayGuard();
  guard.consume("event-id", nowSeconds);
  assert.throws(() => guard.consume("event-id", nowSeconds), BuildOnBuzzError);
});

test("rate limiter caps build rooms per identity", () => {
  const limiter = new BuildRateLimiter(2, 60);
  limiter.consume("pubkey", nowSeconds);
  limiter.consume("pubkey", nowSeconds + 1);
  assert.throws(() => limiter.consume("pubkey", nowSeconds + 2), BuildOnBuzzError);
  limiter.consume("pubkey", nowSeconds + 61);
});

test("Flint membership check maps relay authorization failures to a clear error", async () => {
  const signed = await signedRequest();
  const verified = verifyBuildRequest(
    signed.authorizationHeader,
    signed.rawBody,
    { channelCreatorNsec: tokenSecret, publicOrigin, relayHttpUrl },
    nowSeconds
  );
  const fetchImpl = (async () => new Response("{}", { status: 403 })) as typeof fetch;

  await assert.rejects(
    () => confirmFlintMembership(verified, relayHttpUrl, fetchImpl),
    (error: unknown) =>
      error instanceof BuildOnBuzzError &&
      error.status === 403 &&
      error.publicMessage.includes("Flint")
  );
});

test("creates a public channel, adds the user and bot, posts in order, and announces in general", async () => {
  const { agentPubkey, requestId, serviceKey, serviceNsec, userPubkey, verified } =
    verifiedAgentFixture();
  const submitted: NostrEvent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/query")) {
      return new Response("[]", { status: 200 });
    }

    const event = JSON.parse(String(init?.body)) as NostrEvent;
    assert.equal(verifyEvent(event), true);
    assert.match(String(new Headers(init?.headers).get("Authorization")), /^Nostr /);
    submitted.push(event);
    return new Response(
      JSON.stringify({ accepted: true, event_id: `event-${submitted.length}`, message: "" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const result = await createBuildChannel(
    verified,
    {
      channelCreatorNsec: serviceNsec,
      expectedCreatorPubkey: getPublicKey(serviceKey),
      publicOrigin,
      relayHttpUrl,
      generalChannelId
    },
    fetchImpl
  );

  assert.equal(result.channelId, requestId);
  assert.match(result.channelName, /^build-permitpatch-/);
  assert.deepEqual(
    submitted.map((event) => event.kind),
    [9007, 9000, 9000, 9, 9, 9]
  );
  assert.ok(submitted[0].tags.some((tag) => tag[0] === "visibility" && tag[1] === "open"));
  assert.ok(submitted[1].tags.some((tag) => tag[0] === "p" && tag[1] === userPubkey));
  assert.equal(submitted[2].pubkey, userPubkey);
  assert.ok(submitted[2].tags.some((tag) => tag[0] === "p" && tag[1] === agentPubkey));
  assert.ok(submitted[3].tags.some((tag) => tag[0] === "p" && tag[1] === userPubkey));
  assert.match(submitted[3].content, /selected build agent has been added/i);
  assert.equal(submitted[4].pubkey, userPubkey);
  assert.equal(submitted[4].content, formatAgentCommand(agentPubkey));
  assert.ok(submitted[4].tags.some((tag) => tag[0] === "p" && tag[1] === agentPubkey));
  assert.ok(
    submitted[5].tags.some((tag) => tag[0] === "h" && tag[1] === generalChannelId)
  );
  assert.match(submitted[5].content, new RegExp(requestId));
  assert.equal(result.agentMessageEventId, "event-5");
  assert.equal(result.announcementEventId, "event-6");
});

test("stops before the brief and command when the user-signed agent add fails", async () => {
  const { serviceKey, serviceNsec, verified } = verifiedAgentFixture();
  const submitted: NostrEvent[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/query")) {
      return new Response("[]", { status: 200 });
    }

    const event = JSON.parse(String(init?.body)) as NostrEvent;
    submitted.push(event);
    if (submitted.length === 3) {
      return new Response(
        JSON.stringify({ accepted: false, message: "policy:owner_only" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ accepted: true, event_id: `event-${submitted.length}`, message: "" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  await assert.rejects(
    () =>
      createBuildChannel(
        verified,
        {
          channelCreatorNsec: serviceNsec,
          expectedCreatorPubkey: getPublicKey(serviceKey),
          publicOrigin,
          relayHttpUrl,
          generalChannelId
        },
        fetchImpl
      ),
    (error: unknown) =>
      error instanceof BuildOnBuzzError &&
      error.publicMessage.includes("channel-add policy")
  );

  assert.deepEqual(
    submitted.map((event) => event.kind),
    [9007, 9000, 9000, 9008]
  );
  assert.equal(submitted.some((event) => event.kind === 9), false);
});

test("kickoff contains the full idea and direct build request", () => {
  const kickoff = formatBuildKickoff(idea, "@Builder");
  for (const value of Object.values(idea)) {
    assert.match(kickoff, new RegExp(escapeRegExp(String(value)), "i"));
  }
  assert.match(kickoff, /@Builder, add your favorite agent/i);
});

test("general announcement links directly to the build brief", () => {
  const message = formatGeneralAnnouncement(
    idea,
    "build-permitpatch-7441b30a",
    "7441b30a-a914-4c7f-96b2-dad20df72d56",
    "abc123"
  );

  assert.match(message, /PermitPatch/);
  assert.match(
    message,
    /buzz:\/\/message\?channel=7441b30a-a914-4c7f-96b2-dad20df72d56&id=abc123/
  );
});

async function signedRequest(options?: {
  agentPubkey?: string;
  commandChannelId?: string;
  createdAt?: number;
  relaySecretKey?: Uint8Array;
  requestIdea?: BuildIdea;
  tokenIdea?: BuildIdea;
}) {
  const secretKey = generateSecretKey();
  const relaySecretKey = options?.relaySecretKey ?? secretKey;
  const pubkey = getPublicKey(secretKey);
  const requestId = "7441b30a-a914-4c7f-96b2-dad20df72d56";
  const createdAt = options?.createdAt ?? nowSeconds;
  const relayBody = relayMembershipQueryBody(pubkey);
  const relayAuthorization = nip98Event(
    relaySecretKey,
    `${relayHttpUrl}/query`,
    relayBody,
    createdAt
  );
  const addEvent = options?.agentPubkey
    ? finalizeEvent(
        {
          kind: 9000,
          created_at: createdAt,
          content: "",
          tags: [
            ["h", requestId],
            ["p", options.agentPubkey]
          ]
        },
        secretKey
      )
    : undefined;
  const addEventBody = addEvent ? JSON.stringify(addEvent) : undefined;
  const commandEvent = options?.agentPubkey
    ? finalizeEvent(
        {
          kind: 9,
          created_at: createdAt,
          content: formatAgentCommand(options.agentPubkey),
          tags: [
            ["h", options.commandChannelId ?? requestId],
            ["p", options.agentPubkey]
          ]
        },
        secretKey
      )
    : undefined;
  const commandEventBody = commandEvent ? JSON.stringify(commandEvent) : undefined;
  const request = {
    idea: {
      ...addBuildToken(options?.tokenIdea ?? options?.requestIdea ?? idea, tokenSecret),
      ...(options?.requestIdea ?? idea)
    },
    requestId,
    relayAuthorization,
    ...(options?.agentPubkey && addEventBody && commandEventBody
      ? {
          agentCommand: {
            agentPubkey: options.agentPubkey,
            addEventBody,
            addRelayAuthorization: nip98Event(
              secretKey,
              `${relayHttpUrl}/events`,
              addEventBody,
              createdAt
            ),
            commandEventBody,
            commandRelayAuthorization: nip98Event(
              secretKey,
              `${relayHttpUrl}/events`,
              commandEventBody,
              createdAt
            )
          }
        }
      : {})
  };
  const rawBody = Buffer.from(JSON.stringify(request));
  const authorization = nip98Event(
    secretKey,
    `${publicOrigin}/api/build-on-buzz`,
    rawBody,
    createdAt
  );

  return {
    authorizationHeader: `Nostr ${Buffer.from(JSON.stringify(authorization)).toString("base64")}`,
    pubkey,
    rawBody,
    requestId
  };
}

function verifiedAgentFixture() {
  const serviceKey = generateSecretKey();
  const userKey = generateSecretKey();
  const agentPubkey = getPublicKey(generateSecretKey());
  const userPubkey = getPublicKey(userKey);
  const serviceNsec = Buffer.from(serviceKey).toString("hex");
  const requestId = "7441b30a-a914-4c7f-96b2-dad20df72d56";
  const addEvent = finalizeEvent(
    {
      kind: 9000,
      created_at: nowSeconds,
      content: "",
      tags: [
        ["h", requestId],
        ["p", agentPubkey]
      ]
    },
    userKey
  );
  const addEventBody = JSON.stringify(addEvent);
  const commandEvent = finalizeEvent(
    {
      kind: 9,
      created_at: nowSeconds,
      content: formatAgentCommand(agentPubkey),
      tags: [
        ["h", requestId],
        ["p", agentPubkey]
      ]
    },
    userKey
  );
  const commandEventBody = JSON.stringify(commandEvent);
  const verified: VerifiedBuildRequest = {
    authorizationId: "authorization-id",
    userPubkey,
    request: {
      idea: addBuildToken(idea, serviceNsec),
      requestId,
      agentCommand: {
        agentPubkey,
        addEvent,
        addEventBody,
        addRelayAuthorization: nip98Event(
          userKey,
          `${relayHttpUrl}/events`,
          addEventBody,
          nowSeconds
        ),
        commandEvent,
        commandEventBody,
        commandRelayAuthorization: nip98Event(
          userKey,
          `${relayHttpUrl}/events`,
          commandEventBody,
          nowSeconds
        )
      },
      relayAuthorization: finalizeEvent(
        {
          kind: 27235,
          created_at: nowSeconds,
          content: "",
          tags: [["nonce", "test"]]
        },
        userKey
      )
    }
  };

  return { agentPubkey, requestId, serviceKey, serviceNsec, userPubkey, verified };
}

function nip98Event(
  secretKey: Uint8Array,
  url: string,
  body: string | Buffer,
  createdAt: number
) {
  return finalizeEvent(
    {
      kind: 27235,
      created_at: createdAt,
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
        ["nonce", "test-nonce"]
      ]
    },
    secretKey
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
