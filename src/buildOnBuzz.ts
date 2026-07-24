import { decode, npubEncode } from "nostr-tools/nip19";
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from "nostr-tools/pure";

export const FLINT_RELAY_HTTP_URL = "https://flint.communities.buzz.xyz";

export interface BuzzBuildIdea {
  rank: number;
  name: string;
  tagline: string;
  platform: "native mobile" | "webapp" | "desktop app" | "cross-platform";
  targetUser: string;
  concept: string;
  viralHook: string;
  buildScope: string;
  difficulty: "weekend" | "one-week" | "multi-week";
  buildToken: string;
}

export interface SignedBuildRequest {
  authorization: string;
  body: string;
}

const NIP98_KIND = 27235;
const BOT_COMMAND = "build the idea described above. one shot, make no mistakes.";

export async function signBuildRequest(
  nsec: string,
  idea: BuzzBuildIdea,
  agentPubkeyInput = ""
): Promise<SignedBuildRequest> {
  const secretKey = decodeNsec(nsec);

  try {
    const pubkey = getPublicKey(secretKey);
    const requestId = crypto.randomUUID();
    const agentPubkey = decodePublicKey(agentPubkeyInput);
    const relayQuery = JSON.stringify([{ kinds: [0], authors: [pubkey], limit: 1 }]);
    const relayAuthorization = await signNip98(
      secretKey,
      `${FLINT_RELAY_HTTP_URL}/query`,
      relayQuery
    );
    const agentCommand = agentPubkey
      ? await signAgentHandoff(secretKey, requestId, agentPubkey)
      : undefined;
    const body = JSON.stringify({
      idea,
      requestId,
      relayAuthorization,
      ...(agentCommand ? { agentCommand } : {})
    });
    const authorization = await signNip98(
      secretKey,
      `${window.location.origin}/api/build-on-buzz`,
      body
    );

    return {
      authorization: `Nostr ${btoa(JSON.stringify(authorization))}`,
      body
    };
  } finally {
    secretKey.fill(0);
  }
}

async function signAgentHandoff(
  secretKey: Uint8Array,
  channelId: string,
  agentPubkey: string
) {
  const addEvent = finalizeEvent(
    {
      kind: 9000,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["h", channelId],
        ["p", agentPubkey]
      ]
    },
    secretKey
  );
  const addEventBody = JSON.stringify(addEvent);
  const addRelayAuthorization = await signNip98(
    secretKey,
    `${FLINT_RELAY_HTTP_URL}/events`,
    addEventBody
  );
  const commandEvent = finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content: `nostr:${npubEncode(agentPubkey)} ${BOT_COMMAND}`,
      tags: [
        ["h", channelId],
        ["p", agentPubkey]
      ]
    },
    secretKey
  );
  const commandEventBody = JSON.stringify(commandEvent);
  const commandRelayAuthorization = await signNip98(
    secretKey,
    `${FLINT_RELAY_HTTP_URL}/events`,
    commandEventBody
  );

  return {
    agentPubkey,
    addEventBody,
    addRelayAuthorization,
    commandEventBody,
    commandRelayAuthorization
  };
}

function decodeNsec(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("nsec1")) {
    throw new Error("Enter a valid nsec for the Flint Buzz community.");
  }

  try {
    const decoded = decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new Error("Wrong key type.");
    }
    return Uint8Array.from(decoded.data);
  } catch {
    throw new Error("Enter a valid nsec for the Flint Buzz community.");
  }
}

function decodePublicKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();

  try {
    const decoded = decode(trimmed);
    if (decoded.type === "npub") {
      return decoded.data;
    }
  } catch {
    // Fall through to the validation error below.
  }

  throw new Error("Enter the agent pubkey as a 64-character hex key or npub.");
}

async function signNip98(secretKey: Uint8Array, url: string, body: string): Promise<NostrEvent> {
  return finalizeEvent(
    {
      kind: NIP98_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", await sha256Hex(body)],
        ["nonce", crypto.randomUUID()]
      ]
    },
    secretKey
  );
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
