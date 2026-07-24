import { decode } from "nostr-tools/nip19";
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

export async function signBuildRequest(nsec: string, idea: BuzzBuildIdea): Promise<SignedBuildRequest> {
  const secretKey = decodeNsec(nsec);

  try {
    const pubkey = getPublicKey(secretKey);
    const relayQuery = JSON.stringify([{ kinds: [0], authors: [pubkey], limit: 1 }]);
    const relayAuthorization = await signNip98(
      secretKey,
      `${FLINT_RELAY_HTTP_URL}/query`,
      relayQuery
    );
    const body = JSON.stringify({
      idea,
      requestId: crypto.randomUUID(),
      relayAuthorization
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
