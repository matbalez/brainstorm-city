# Brainstorm City

A mobile-first app idea generator. Users enter optional direction, platform, audience, and a reach target. The server calls OpenAI with a compact structured-output JSON schema and the UI renders five ranked idea cards.

## Local setup

```bash
npm install
cp .env.example .env.local
```

Add your real key to `.env.local`:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-luna
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

`fly.toml` uses `brainstorm-city` in the `sea` region. If that app name is taken, rename the `app` value before deployment.

## License

MIT
