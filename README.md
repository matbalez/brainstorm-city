# Brainstorm City

A mobile-first app idea generator. Users enter optional direction, platform, audience, and a reach target. The server calls OpenAI with a compact structured-output JSON schema and the UI renders five ranked idea cards.

Each card also has **🐝 Build it on Buzz**. The user signs short-lived authorizations with their Flint `nsec` entirely in the browser. The raw key is immediately cleared and is never sent to Brainstorm City. After Flint verifies that identity is a community member, the server uses its configured channel-creator identity to create a public build room, add the user, post the full idea, and announce the room in `#general`. The user can optionally provide an agent pubkey; the browser signs both the roster addition and one-shot command as the user, and the server relays them in that order around the idea brief.

## Local setup

```bash
npm install
cp .env.example .env.local
```

Add your real key to `.env.local`:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-luna
PUBLIC_ORIGIN=http://localhost:8080
BUZZ_RELAY_URL=https://flint.communities.buzz.xyz
BUZZ_CHANNEL_CREATOR_NSEC=nsec1...
BUZZ_CHANNEL_CREATOR_PUBKEY=<matching 64-character hex pubkey>
BUZZ_GENERAL_CHANNEL_ID=0683e2de-c0c9-496d-bb1f-46d679e3bf38
```

Then run:

```bash
npm run dev
```

The app runs at `http://localhost:8080` by default.

## Fly deploy

Set the secret before deploying:

```bash
flyctl secrets set OPENAI_API_KEY=...
flyctl deploy
```

Set the channel-creator nsec without putting it in source control or chat. `flyctl secrets import` reads the value from stdin:

```bash
read -s "buzz_creator_nsec?Buzz channel creator nsec: "
printf 'BUZZ_CHANNEL_CREATOR_NSEC=%s\n' "$buzz_creator_nsec" | flyctl secrets import -a brainstorm-city
unset buzz_creator_nsec
```

`fly.toml` pins the expected public key so a wrong creator secret fails closed. It uses `brainstorm-city` in the `sjc` region. If that app name is taken, rename the `app` value before deployment.

## Security notes

- The browser does not store the user nsec in React state, local storage, cookies, logs, or requests.
- Both the Brainstorm City request and the Flint membership probe use signed NIP-98 events bound to exact URLs and payload hashes.
- Every generated idea carries a server HMAC, so a Flint member cannot edit the payload and make the channel-creator identity post arbitrary copy.
- Authorizations expire after two minutes, carry nonces, and are rejected on replay.
- Build creation is rate-limited per Flint identity.
- New build rooms are public. If any relay step fails after creation, the server attempts to delete the partial room.
- Optional agent additions and commands are signed in the browser by the user and constrained to the new room, selected agent pubkey, and exact event contents.
- Prefer a NIP-07/NIP-46 or Buzz approval flow over pasted nsecs when one becomes available.

## License

MIT
