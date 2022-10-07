import { corsHeaders, handleOptions } from "./cors";
import { indexHTML } from "./indexHtml";

export type Env = {
  KV_MAX_FILE_SIZE_BYTES: string
  KV_DEFAULT_FILE_TTL: string
  KV_DEFAULT_NAMESPACE: string
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

    const kv = env[env.KV_DEFAULT_NAMESPACE];
    if(!kv) throw "No KV namespace";

    const url = new URL(request.url);
    if (request.method === "PUT") {
      const filename = url.pathname.replace(/^\//, "");
      if(filename.length < 1) return new Response(`No filename, pass a filename into the url, like: ${url.origin + '/filename.txt'} \n`, { status: 400, headers });
      if(filename.length > 256) return new Response(`Filename too long, max 256 characters`, { status: 400, headers });
      const expiry = Math.floor(Date.now()/1000) + parseInt(env.KV_DEFAULT_FILE_TTL);
      const random = (Math.floor(Math.random() * Math.pow(2, 16))).toString(16);
      const key = `${random}-${expiry.toString(16)}/${filename}`;
      // ctx.waitUntil(request.arrayBuffer().then(a => kv.put(key, a, { expirationTtl: ttl })));
      // let size = parseInt(request.headers.get('content-length') || '0');

      const file = await request.arrayBuffer();
      const size = file.byteLength
      if(size < 5 || size > parseInt(env.KV_MAX_FILE_SIZE_BYTES)) return new Response(`Invalid file size: ${size}, max size = ${env.KV_MAX_FILE_SIZE_BYTES}`, { status: 400, headers });
      ctx.waitUntil(kv.put(key, file, { expirationTtl: env.KV_DEFAULT_FILE_TTL }));
      return new Response(url.origin + "/" + key + "\n", { status: 200, ...headers });
    }

    if (request.method === "GET") {
      const key = url.pathname.replace(/^\//, "");
      if(key.length < 1) return new Response(indexHTML, { status: 200, headers: {
        "Content-Type": "text/html", ...corsHeaders,
        } });
      const value = await kv.get(key, "arrayBuffer");
      if (!value) return new Response("Not Found\n", { status: 404, headers });
      return new Response(value, { status: 200, headers: { ...corsHeaders } });
    }

    return new Response(`Method not allowed, send a PUT request to upload a file and GET request to download, for more details read ${url.origin} \n`, { status: 400, headers });
  }
};
