# transfr.one worker

A Cloudflare Worker for dead-simple, temporary file transfer: `PUT` a file, get
back a URL with an unguessable key, and the file is gone after 24 hours. Files
are stored in [R2](https://developers.cloudflare.com/r2/) and can be encrypted
end-to-end in the browser (OpenPGP) before they ever leave the machine.

Check it out: https://transfr.one

## API

| Method       | Path       | Description                                                                              |
| ------------ | ---------- | ---------------------------------------------------------------------------------------- |
| `GET`        | `/`        | The landing page with usage instructions.                                                 |
| `PUT`/`POST` | `/<name>`  | Upload a file, returns the URL to download it from.                                       |
| `GET`/`HEAD` | `/<key>`   | Download a file. Browsers get an HTML page instead; `?raw` always returns the bytes.      |
| `OPTIONS`    | any        | CORS preflight.                                                                           |

```sh
curl --upload-file ./file.txt https://transfr.one/file.txt
# https://transfr.one/68d0f3a2-3f1c9b27d4e0/file.txt

curl -L https://transfr.one/68d0f3a2-3f1c9b27d4e0/file.txt > file.txt
```

Encrypt before uploading to keep the contents private from the server:

```sh
gpg -c -o- file.txt | curl https://transfr.one/file.txt.pgp --data-binary @-
```

Object keys are `<expiry-hex>-<random-hex>/<file name>`. The expiry is part of
the key, so the worker stops serving a file on time even though R2 lifecycle
rules only delete once a day; the 6 random bytes are the only secret protecting
a file, so treat the URL like a password.

Uploads are served back with `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff` unless they are a type the browser can safely
render in place (images other than SVG, video, audio, `text/plain`), so an
uploaded HTML file cannot run script on the worker's origin.

## Layout

```
html/            the two pages, as plain HTML with {{TOKEN}} placeholders
  index.html       landing page: drag & drop upload, optional PGP encryption
  access.html      what a browser sees for an uploaded file, with PGP decryption
src/
  index.ts         entry point and routing
  upload.ts        PUT/POST: validation and storing the object
  download.ts      GET/HEAD: ranges, conditional requests, download headers
  pages.ts         fills the HTML templates
  templates.ts     single pass {{TOKEN}} substitution
  escape.ts        HTML and JSON-in-script escaping
  keys.ts          key generation, expiry parsing
  config.ts        bindings and variables, validated
  cors.ts          CORS headers and preflight
  http.ts          response helpers and page security headers
  mime.ts          content type validation, Content-Disposition
  format.ts        human readable sizes and durations
test/            vitest tests, run inside workerd via @cloudflare/vitest-pool-workers
```

The HTML files are bundled as text modules (the `Text` rule in `wrangler.toml`),
so they are plain editable HTML rather than strings inside TypeScript.

## Development

```sh
npm install
npm run dev        # wrangler dev, R2 simulated locally
npm test           # vitest, runs the worker inside workerd
npm run typecheck
```

## Initial setup

Install [wrangler](https://developers.cloudflare.com/workers/wrangler/get-started/)
and log in with `wrangler login`.

1. Create the bucket and have R2 clean up after itself:

   ```sh
   wrangler r2 bucket create transfr-temp-store
   wrangler r2 bucket lifecycle add transfr-temp-store expire-1-day "" --expire-days 1
   ```

2. Point `wrangler.toml` at it: set `bucket_name` under `[[r2_buckets]]`, and
   make sure `binding` matches the `R2_DEFAULT_NAMESPACE` variable.

3. Deploy and map the route to your domain on the Cloudflare dashboard:

   ```sh
   npm run deploy
   ```

### Configuration

Variables in `wrangler.toml` under `[vars]`:

| Variable                 | Default    | Description                                                     |
| ------------------------ | ---------- | --------------------------------------------------------------- |
| `R2_DEFAULT_NAMESPACE`   | –          | Name of the R2 binding to store files in (required).            |
| `R2_MAX_FILE_SIZE_BYTES` | `21000000` | Largest accepted upload.                                        |
| `R2_DEFAULT_FILE_TTL`    | `86400`    | File lifetime in seconds.                                       |
| `RAW_ONLY_HOSTS`         | –          | Hosts that always serve bytes, never the HTML page, e.g. for embedding. |

An invalid value is a startup error rather than a silently ignored limit.
