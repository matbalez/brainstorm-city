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
  const payload = buildOpenAIRequest(body, virality);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const responseBody = (await response.json()) as OpenAIResponsePayload;

  if (!response.ok) {
    sendJson(res, response.status, {
      message: responseBody.error?.message ?? "OpenAI could not generate ideas right now."
    });
    return;
  }

  const text = extractOutputText(responseBody);
  const parsed = JSON.parse(text) as unknown;

  sendJson(res, 200, parsed);
}

async function createDevServer() {
  const { createServer: createViteServer } = await import("vite");

  return createViteServer({
    server: { middlewareMode: true },
    appType: "spa"
  });
}

function buildOpenAIRequest(input: GenerateRequest, virality: number) {
  const platform = input.platform || "any app platform";
  const direction = clean(input.direction) || "No specific theme. Find a sharp opportunity.";
  const audience = clean(input.targetAudience) || "A high-intent audience with a real recurring problem.";

  return {
    model: process.env.OPENAI_MODEL || "gpt-5.5",
    input: [
      {
        role: "system",
        content:
          "You are a product strategist for fast prototype builders. Generate concrete, testable app ideas with clear user pain, believable scope, and memorable hooks. Avoid generic AI wrappers."
      },
      {
        role: "user",
        content: [
          "Create a ranked top 10 list of hit product ideas for vibe coding.",
          `Direction: ${direction}`,
          `Preferred platform: ${platform}`,
          `Target audience: ${audience}`,
          `Virality target: ${virality}/100 (${viralityLabel(virality)}).`,
          "Each idea should feel original, feasible for an MVP, and specific enough to start building."
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
              minItems: 10,
              maxItems: 10,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "rank",
                  "name",
                  "tagline",
                  "platform",
                  "targetUser",
                  "concept",
                  "whyNow",
                  "viralHook",
                  "buildScope",
                  "difficulty"
                ],
                properties: {
                  rank: { type: "integer", minimum: 1, maximum: 10 },
                  name: { type: "string", minLength: 2, maxLength: 52 },
                  tagline: { type: "string", minLength: 8, maxLength: 110 },
                  platform: {
                    type: "string",
                    enum: ["native mobile", "webapp", "desktop app", "cross-platform"]
                  },
                  targetUser: { type: "string", minLength: 4, maxLength: 120 },
                  concept: { type: "string", minLength: 40, maxLength: 420 },
                  whyNow: { type: "string", minLength: 20, maxLength: 220 },
                  viralHook: { type: "string", minLength: 16, maxLength: 220 },
                  buildScope: { type: "string", minLength: 20, maxLength: 220 },
                  difficulty: { type: "string", enum: ["weekend", "one-week", "multi-week"] }
                }
              }
            }
          }
        }
      }
    },
    max_output_tokens: 5000
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
