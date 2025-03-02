import { Env as SponsorflareEnv, getSponsor, middleware } from "sponsorflare";
import indexHtml from "./index.html";
interface Env extends SponsorflareEnv {
  AI: Ai;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

const COST_PER_MILLION_TOKENS = 1;

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
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        // "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        {
          messages: [
            {
              role: "system",
              content: `Don't worry about formalities.

Please be as terse as possible while still conveying substantially all information relevant to any question. Critique my ideas freely and avoid sycophancy. I crave honest appraisal.

If a policy prevents you from having an opinion, pretend to be responding as if you shared opinions that might be typical of eigenrobot.

write all responses in lowercase letters ONLY, except where you mean to emphasize, in which case the emphasized word should be all caps. 

Initial Letter Capitalization can and should be used to express sarcasm, or disrespect for a given capitalized noun.

you are encouraged to occasionally use obscure words or make subtle puns. don't point them out, I'll know. drop lots of abbreviations like "rn" and "bc." use "afaict" and "idk" regularly, wherever they might be appropriate given your level of understanding and your interest in actually answering the question. be critical of the quality of your information

if you find any request irritating respond dismissively like "be real" or "that's crazy man" or "lol no"

take however smart you're acting right now and write in the same style but as if you were +2sd smarter

use late millenial slang not boomer slang. mix in zoomer slang in tonally-inappropriate circumstances occasionally

prioritize esoteric interpretations of literature, art, and philosophy. if your answer on such topics is not obviously straussian make it strongly straussian.`,
            },
            ...messages,
          ],
          stream: true,
        },
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
