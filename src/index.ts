import { corsHeaders, handleOptions } from "./cors";
import { indexHTML } from "../dist/index.html.js";
import { accessHTML } from "../dist/access.html.js";

export type Env = {
  R2_MAX_FILE_SIZE_BYTES: string
  R2_DEFAULT_FILE_TTL: string
  R2_DEFAULT_NAMESPACE: string
  [key: string]: any
}

const headers = {
  "Content-Type": "text/plain",
  ...corsHeaders
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (request.method === "OPTIONS") {
      // Handle CORS preflight requests
      return handleOptions(request);
    }

    const r2 = env[env.R2_DEFAULT_NAMESPACE] as R2Bucket;
    if (!r2) throw "No R2 Bucket";

    const url = new URL(request.url);
    if (request.method === "PUT" || request.method === "POST") {
      const filename = url.pathname.replace(/^\//, "");
      if (filename.length < 1) return new Response(`No filename, pass a filename into the url, like: ${url.origin + "/filename.txt"} \n`, {
        status: 400,
        headers
      });
      if (filename.length > 256) return new Response(`Filename too long, max 256 characters`, { status: 400, headers });
      const expiry = Math.floor(Date.now() / 1000) + parseInt(env.R2_DEFAULT_FILE_TTL);
      const random = (Math.floor(Math.random() * Math.pow(2, 8))).toString(16);
      const key = `${expiry.toString(16)}-${random}/${filename}`;

      const file = await request.arrayBuffer();
      const size = file.byteLength;
      if (size < 0 || size > parseInt(env.R2_MAX_FILE_SIZE_BYTES)) return new Response(`Invalid file size: ${size}, max size = ${env.R2_MAX_FILE_SIZE_BYTES}`, {
        status: 400,
        headers
      });
      ctx.waitUntil(r2.put(key, file, { httpMetadata: { contentType: request.headers.get("content-type") || undefined } }));
      return new Response(url.origin + "/" + key + "\n", { status: 200, headers: {
        ...headers,
        // "Access-Control-Allow-Origin": "https://transfr.one/*",
        ...corsHeaders,
        }
      });
    }

    if (request.method === "GET") {
      const key = url.pathname.replace(/^\//, "").split("?")[0];
      const isBrowser = request.headers.get("user-agent")?.includes("Mozilla");
      //todo check if coming directly from browser tab or coming from embed on a page.
      if (isBrowser && !request.url.includes('bee.transfr.one') && url.searchParams.get("raw") === null && key.length > 0) {
        let value = await r2.head(key);
        if (!value) return new Response("Not Found\n", { status: 404, headers });
        const size = value.size;
        const contentType = value.httpMetadata?.contentType;
        const filename = key.split("/").slice(1).join("/");
        const isEncrypted = key.endsWith(".pgp") || url.searchParams.get("enc") !== null || contentType?.includes("pgp-encrypted");

        return new Response(
          accessHTML
            .replace(/NOT_ENCRYPTED_DISPLAY/g, isEncrypted ? "none" : "block")
            .replace(/ENCRYPTED_DISPLAY/g, isEncrypted ? "block" : "none")
            .replace(/IS_ENCRYPTED/g, isEncrypted ? "true" : "false")
            .replace(/FILE_SIZE/g, size.toString())
            .replace(/FILE_LINK_RAW/g, request.url + "?raw")
            .replace(/FILE_LINK/g, request.url)
            .replace(/FILE_NAME_RAW/g, filename.replace(/\.pgp$/, ""))
            .replace(/FILE_NAME/g, filename)
          , {
            status: 200, headers: {
              "Content-Type": "text/html", ...corsHeaders,
            }
          });
      }
      if (key.length < 1) return new Response(indexHTML, {
        status: 200, headers: {
          "Content-Type": "text/html", ...corsHeaders
        }
      });
      let value = await (await r2.get(key))?.arrayBuffer();
      if (!value) return new Response("Not Found\n", { status: 404, headers });
      return new Response(value, { status: 200, headers: { ...corsHeaders } });
    }

    return new Response(`Method not allowed, send a PUT request to upload a file and GET request to download, for more details read ${url.origin} \n`, {
      status: 400,
      headers
    });
  }
};
