import { DurableObject } from "cloudflare:workers";
import { decodeMultiple } from "cbor-x";
import { z } from "zod";
import { filter } from "./filter";

const RelayMessage = z.tuple([
  z.object({
    t: z.string(),
    op: z.number(),
  }),
  z.object({
    seq: z.number(),
  }),
]);

export class RelayListenerDurableObject extends DurableObject<Env> {
  socket!: WebSocket;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#setupSocket();
  }

  async #setupSocket() {
    this.socket = new WebSocket(
      `wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos?cursor=1023143536`,
    );

    this.socket.addEventListener("open", () => {
      console.log("Connected to relay");
    });

    this.socket.addEventListener("message", (event) => {
      this.ctx.blockConcurrencyWhile(async () => {
        if (typeof event.data === "string") {
          throw new Error("Expected binary data");
        }
        const message = RelayMessage.parse(
          decodeMultiple(new Uint8Array(event.data)),
        );
        if (filter(message)) {
          await this.env.ATPROTO_FIREHOSE_QUEUE.send(message, {
            contentType: "json",
          });
        }

        await this.ctx.storage.put("seq", message[1].seq.toString());
      });
    });
  }

  async ping() {
    if (this.socket.readyState === WebSocket.CLOSED) {
      console.log("Reconnecting");
      this.#setupSocket();
    }
  }
}

export default {
  async scheduled(_, env) {
    await env.RELAY_LISTENER_DO.get(
      env.RELAY_LISTENER_DO.idFromName("consumer"),
    ).ping();
  },
  async queue(batch, env, ctx) {},
  async fetch(_, env) {
    // This is to start the Durable Object in dev, not needed in prod and we should probably disable it there
    // Or maybe there's a better way to create the Durable Object on startup in dev?
    await env.RELAY_LISTENER_DO.get(
      env.RELAY_LISTENER_DO.idFromName("consumer"),
    ).ping();

    return new Response("pong");
  },
} satisfies ExportedHandler<Env>;
