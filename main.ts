import { Env as SponsorflareEnv, getSponsor, middleware } from "sponsorflare";
import indexHtml from "./index.html";
interface Env extends SponsorflareEnv {
  AI: any;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

const COST_PER_MILLION_TOKENS = 0.5;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sponsorflare = await middleware(request, env);
    if (sponsorflare) return sponsorflare;
    const sponsor = await getSponsor(request, env);

    if (new URL(request.url).pathname === "/") {
      return new Response(
        indexHtml.replace(
          "<script>",
          `<script>\nwindow.data = ${JSON.stringify({ sponsor })};\n\n`,
        ),
        {
          headers: { "content-type": "text/html" },
        },
      );
    }
    const { spent, clv, is_authenticated } = sponsor;
    const budget = (clv || 0) - (spent || 0);
    if (!is_authenticated) {
      return new Response("Unauthenticated", { status: 401 });
    }

    if (budget < -100) {
      return new Response("Payment required", {
        status: 402,
        headers: { "x-payment-url": "https://github.com/sponsors/janwilmake" },
      });
    }

    if (
      request.method !== "POST" ||
      !request.url.endsWith("/chat/completions")
    ) {
      return new Response("Not Found", { status: 404 });
    }

    try {
      const { messages }: any = await request.json();
      const stream = await env.AI.run(
        "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        { messages, stream: true },
      );

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      // Process the stream
      processStream(request, env, stream, writer).catch(console.error);

      return new Response(readable, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    } catch (error: any) {
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  },
};

async function processStream(
  request: Request,
  env: Env,
  stream: ReadableStream,
  writer: WritableStreamDefaultWriter,
): Promise<void> {
  const reader = stream.getReader();
  let buffer = "";
  let cost;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = new TextDecoder().decode(value);
      buffer += chunk;

      // Process usage data if stream is complete
      if (buffer.includes("[DONE]")) {
        const usageMatch = buffer.match(/data: {"response":"","usage".*?}\n/s);
        if (usageMatch) {
          const usageData = JSON.parse(usageMatch[0].replace("data: ", ""));
          cost = calculateCost(usageData.usage);
        }
      }

      await writer.write(value);
    }
  } finally {
    if (cost !== undefined) {
      const { charged } = await getSponsor(request, env, {
        charge: cost * 100,
        allowNegativeClv: true,
      });
      console.log("We did it! ", { cost, charged });
    } else {
      console.log("NO COST FOUND");
    }

    reader.releaseLock();
    await writer.close();
  }
}

function calculateCost(usage: Usage): number {
  return (usage.total_tokens * COST_PER_MILLION_TOKENS) / 1_000_000;
}
