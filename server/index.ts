import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

type Platform = "native mobile" | "webapp" | "desktop app";

interface GenerateRequest {
  direction?: string;
  platform?: Platform | "";
  targetAudience?: string;
  virality?: number;
}

interface CompactIdea {
  r: number;
  n: string;
  t: string;
  p: Platform | "cross-platform";
  u: string;
  c: string;
  h: string;
  s: string;
  d: "weekend" | "one-week" | "multi-week";
}

interface IdeasResponse {
  ideas: Array<{
    rank: number;
    name: string;
    tagline: string;
    platform: CompactIdea["p"];
    targetUser: string;
    concept: string;
    viralHook: string;
    buildScope: string;
    difficulty: CompactIdea["d"];
  }>;
}

interface OpenAIResponsePayload {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
}

const IDEA_COUNT = 5;
const leadingRankPattern = /^(?:(?:rank|no\.?|number)\s*)?#?\d+\s*(?:[.)\-:]\s*|\s+(?=[A-Z]))/i;
const textFields = ["name", "tagline", "targetUser", "concept", "viralHook", "buildScope"] as const;
const danglingEndWords = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "via",
  "with",
  "without"
]);
const rootDir = process.cwd();
const clientDir = resolve(rootDir, "dist", "client");
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 8080);

await loadLocalEnv();
const viteServer = isProduction ? null : await createDevServer();

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

const app = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/generate") {
      await handleGenerate(req, res);
      return;
    }

    if (isProduction) {
      serveStatic(req, res);
      return;
    }

    viteServer?.middlewares(req, res, (error?: unknown) => {
      if (error) {
        viteServer.ssrFixStacktrace(error as Error);
        console.error(error);
        sendJson(res, 500, { message: "Development server error." });
        return;
      }

      sendJson(res, 404, { message: "Not found." });
    });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { message: "Brainstorm City hit a server error." });
  }
});

app.listen(port, () => {
  console.log(`Brainstorm City running at http://localhost:${port}`);
});

async function handleGenerate(req: IncomingMessage, res: ServerResponse) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    sendJson(res, 503, {
      code: "missing_openai_key",
      message: "Live generation needs OPENAI_API_KEY in .env.local or the hosted runtime."
    });
    return;
  }

  const body = await readJsonBody<GenerateRequest>(req);
  const virality = clamp(Number(body.virality ?? 55), 0, 100);
  const startedAt = Date.now();
  let attempts = 1;

  try {
    let parsed = await requestIdeas(apiKey, body, virality, false);
    let issues = findCopyIssues(parsed);

    if (issues.length > 0) {
      attempts = 2;
      parsed = await requestIdeas(apiKey, body, virality, true);
      issues = findCopyIssues(parsed);
    }

    setGenerationTiming(res, Date.now() - startedAt, attempts);

    if (issues.length > 0) {
      sendJson(res, 502, {
        message: "Brainstorm City generated malformed copy. Please try again."
      });
      return;
    }

    sendJson(res, 200, parsed);
  } catch (caught) {
    setGenerationTiming(res, Date.now() - startedAt, attempts);

    if (caught instanceof OpenAIRequestError) {
      sendJson(res, caught.status, { message: caught.message });
      return;
    }

    throw caught;
  }
}

async function requestIdeas(apiKey: string, input: GenerateRequest, virality: number, isRetry: boolean) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildOpenAIRequest(input, virality, isRetry))
  });

  const responseBody = (await response.json()) as OpenAIResponsePayload;

  if (!response.ok) {
    throw new OpenAIRequestError(response.status, responseBody.error?.message ?? "OpenAI could not generate ideas right now.");
  }

  const text = extractOutputText(responseBody);
  return normalizeIdeas(JSON.parse(text) as unknown);
}

class OpenAIRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function findCopyIssues(payload: IdeasResponse) {
  const issues: string[] = [];

  for (const idea of payload.ideas) {
    for (const field of textFields) {
      if (!hasCleanField(field, idea[field])) {
        issues.push(`${idea.rank}.${field}`);
      }
    }
  }

  return issues;
}

function hasCleanField(field: (typeof textFields)[number], text: string) {
  if (!hasCleanEnding(text)) {
    return false;
  }

  if (field === "name" && hasLeadingRank(text)) {
    return false;
  }

  if (field === "targetUser" && /^(It|This|That|The app)\b/.test(text)) {
    return false;
  }

  return true;
}

function hasCleanEnding(text: string) {
  if (!text) {
    return false;
  }

  if (/[#\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFFD]/.test(text)) {
    return false;
  }

  if (/,\d/.test(text) || /[,;:/\\&+\-([{]$/.test(text)) {
    return false;
  }

  const trimmed = text.replace(/[.!?)]$/, "").trim();
  const rawLastWord = trimmed.split(/\s+/).at(-1) ?? "";
  const lastWord = rawLastWord.toLowerCase();

  if (!lastWord || danglingEndWords.has(lastWord) || /^[a-z]{1,2}$/.test(rawLastWord)) {
    return false;
  }

  return /[A-Za-z0-9.!?)]$/.test(text);
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFFD]/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value: unknown) {
  let text = normalizeText(value);

  for (let index = 0; index < 2 && hasLeadingRank(text); index += 1) {
    text = text.replace(leadingRankPattern, "").trim();
  }

  return text;
}

function hasLeadingRank(text: string) {
  return leadingRankPattern.test(text);
}

async function createDevServer() {
  const { createServer: createViteServer } = await import("vite");

  return createViteServer({
    server: { middlewareMode: true },
    appType: "spa"
  });
}

function buildOpenAIRequest(input: GenerateRequest, virality: number, isRetry = false) {
  const model = clean(process.env.OPENAI_MODEL) || "gpt-5.6-luna";
  const platform = clean(input.platform) || "any app platform";
  const direction = clean(input.direction) || "No specific theme. Find a sharp opportunity.";
  const audience = clean(input.targetAudience) || "A high-intent audience with a real recurring problem.";
  const retryInstruction = isRetry
    ? "Regenerate from scratch because the prior copy was malformed. Every string must end as a complete phrase."
    : "Every string must be a complete phrase. Rewrite shorter instead of truncating.";

  return {
    model,
    input: [
      {
        role: "system",
        content:
          "You generate concise app concepts for prototype builders. Favor specific user pain, feasible MVPs, and non-generic hooks. Return compact JSON only. Never end a string with a comma, conjunction, preposition, stray #, hidden character, or clipped word."
      },
      {
        role: "user",
        content: [
          `Create exactly ${IDEA_COUNT} ranked product ideas for vibe coding.`,
          `Direction: ${direction}`,
          `Preferred platform: ${platform}`,
          `Target audience: ${audience}`,
          `Virality target: ${virality}/100 (${viralityLabel(virality)}).`,
          "Field meanings: n=app name, t=tagline, p=platform, u=target audience noun phrase, c=concept sentence, h=share hook, s=MVP scope, d=difficulty.",
          "Do not include ranks, numbers, bullets, or list markers in n; ranking belongs only in r.",
          "Keep c, h, and s to one sentence each. Avoid generic AI wrappers.",
          "Use plain ASCII punctuation. Do not use markdown.",
          retryInstruction
        ].join("\n")
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "brainstorm_city_ideas",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ideas"],
          properties: {
            ideas: {
              type: "array",
              minItems: IDEA_COUNT,
              maxItems: IDEA_COUNT,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "r",
                  "n",
                  "t",
                  "p",
                  "u",
                  "c",
                  "h",
                  "s",
                  "d"
                ],
                properties: {
                  r: { type: "integer", minimum: 1, maximum: IDEA_COUNT },
                  n: { type: "string", minLength: 2, maxLength: 58 },
                  t: { type: "string", minLength: 8, maxLength: 140 },
                  p: {
                    type: "string",
                    enum: ["native mobile", "webapp", "desktop app", "cross-platform"]
                  },
                  u: { type: "string", minLength: 4, maxLength: 150 },
                  c: { type: "string", minLength: 28, maxLength: 280 },
                  h: { type: "string", minLength: 12, maxLength: 180 },
                  s: { type: "string", minLength: 12, maxLength: 180 },
                  d: { type: "string", enum: ["weekend", "one-week", "multi-week"] }
                }
              }
            }
          }
        }
      }
    },
    max_output_tokens: isRetry ? 2600 : 2200
  };
}

function extractOutputText(payload: OpenAIResponsePayload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const chunks =
    payload.output?.flatMap((item) =>
      item.content?.flatMap((content) => (typeof content.text === "string" ? [content.text] : [])) ?? []
    ) ?? [];

  const text = chunks.join("\n").trim();
  if (!text) {
    throw new Error("OpenAI response did not include JSON text.");
  }

  return text;
}

function normalizeIdeas(payload: unknown): IdeasResponse {
  const ideas = typeof payload === "object" && payload && "ideas" in payload ? (payload.ideas as unknown) : null;

  if (!Array.isArray(ideas)) {
    throw new Error("OpenAI response JSON did not include ideas.");
  }

  return {
    ideas: ideas.slice(0, IDEA_COUNT).map((idea, index) => {
      const compact = idea as Partial<CompactIdea>;

      return {
        rank: typeof compact.r === "number" ? compact.r : index + 1,
        name: normalizeName(compact.n),
        tagline: normalizeText(compact.t),
        platform: compact.p ?? "cross-platform",
        targetUser: normalizeText(compact.u),
        concept: normalizeText(compact.c),
        viralHook: normalizeText(compact.h),
        buildScope: normalizeText(compact.s),
        difficulty: compact.d ?? "one-week"
      };
    })
  };
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;

    if (size > 1_000_000) {
      throw new Error("Request body is too large.");
    }

    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalizedPath = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(join(clientDir, normalizedPath));

  if (!filePath.startsWith(clientDir)) {
    sendJson(res, 403, { message: "Forbidden." });
    return;
  }

  const target = existsSync(filePath) && statSync(filePath).isFile() ? filePath : join(clientDir, "index.html");
  const extension = extname(target);

  res.writeHead(200, {
    "Content-Type": mimeTypes[extension] ?? "application/octet-stream",
    "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable"
  });
  createReadStream(target).pipe(res);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function setGenerationTiming(res: ServerResponse, elapsedMs: number, attempts = 1) {
  res.setHeader("Server-Timing", `openai;dur=${elapsedMs}`);
  res.setHeader("X-Generation-Time-Ms", String(elapsedMs));
  res.setHeader("X-Generation-Attempts", String(attempts));
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);
}

function viralityLabel(value: number) {
  if (value < 34) return "niche utility, strong retention, low spectacle";
  if (value < 67) return "shareable, community-friendly, visible outcomes";
  return "broad appeal, social proof loops, screenshot-worthy moments";
}

async function loadLocalEnv() {
  if (isProduction) return;

  for (const filename of [".env.local", ".env"]) {
    const filePath = join(rootDir, filename);
    if (!existsSync(filePath)) continue;

    const contents = await readFile(filePath, "utf8");
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

      const [key, ...parts] = trimmed.split("=");
      if (!key || process.env[key]) continue;

      process.env[key] = parts.join("=").replace(/^["']|["']$/g, "");
    }
  }
}
