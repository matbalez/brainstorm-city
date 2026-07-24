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
  formatBuildKickoff,
  relayMembershipQueryBody,
  verifyBuildRequest,
  type BuildIdea,
  type BuildOnBuzzRequest,
  type VerifiedBuildRequest
} from "./buzz.js";

const nowSeconds = 1_800_000_000;
const publicOrigin = "https://brainstorm-city.example";
const relayHttpUrl = "https://flint.example";
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

test("creates a private channel, adds the verified user, and p-tags the kickoff", async () => {
  const serviceKey = generateSecretKey();
  const userKey = generateSecretKey();
  const userPubkey = getPublicKey(userKey);
  const serviceNsec = Buffer.from(serviceKey).toString("hex");
  const requestId = "7441b30a-a914-4c7f-96b2-dad20df72d56";
  const verified: VerifiedBuildRequest = {
    authorizationId: "authorization-id",
    userPubkey,
    request: {
      idea: addBuildToken(idea, serviceNsec),
      requestId,
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
      relayHttpUrl
    },
    fetchImpl
  );

  assert.equal(result.channelId, requestId);
  assert.match(result.channelName, /^build-permitpatch-/);
  assert.deepEqual(
    submitted.map((event) => event.kind),
    [9007, 9000, 9]
  );
  assert.ok(submitted[0].tags.some((tag) => tag[0] === "visibility" && tag[1] === "private"));
  assert.ok(submitted[1].tags.some((tag) => tag[0] === "p" && tag[1] === userPubkey));
  assert.ok(submitted[2].tags.some((tag) => tag[0] === "p" && tag[1] === userPubkey));
  assert.match(submitted[2].content, /add your favorite agent/i);
});

test("kickoff contains the full idea and direct build request", () => {
  const kickoff = formatBuildKickoff(idea, "@Builder");
  for (const value of Object.values(idea)) {
    assert.match(kickoff, new RegExp(escapeRegExp(String(value)), "i"));
  }
  assert.match(kickoff, /@Builder, add your favorite agent/i);
});

async function signedRequest(options?: {
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
  const request: BuildOnBuzzRequest = {
    idea: {
      ...addBuildToken(options?.tokenIdea ?? options?.requestIdea ?? idea, tokenSecret),
      ...(options?.requestIdea ?? idea)
    },
    requestId,
    relayAuthorization
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
