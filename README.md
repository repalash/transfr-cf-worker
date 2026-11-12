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
| `GET`/`HEAD` | `/<key>`   | Download a file. Opening the link in a browser shows an HTML page instead; `?raw` always returns the bytes. |
| `OPTIONS`    | any        | CORS preflight.                                                                           |

```sh
curl --upload-file ./file.txt https://transfr.one/file.txt
# https://transfr.one/3f1c9b27d4e0-68d0f3a2/file.txt

curl -L https://transfr.one/3f1c9b27d4e0-68d0f3a2/file.txt > file.txt
```

Encrypt before uploading to keep the contents private from the server:

```sh
gpg -c -o- file.txt | curl https://transfr.one/file.txt.pgp --data-binary @-
```

Object keys are `<random-hex>-<expiry-hex>/<file name>`. The expiry is part of
the key, so the worker stops serving a file on time even though R2 lifecycle
rules only delete once a day; the 6 random bytes are the only secret protecting
a file, so treat the URL like a password.

A form upload works too: `curl -F file=@file.txt https://transfr.one/` stores
the file inside the form, named after the URL path or, without one, after the
file. Forms are read into memory, so they share the lower size limit below.

Only a browser *navigating* to a link gets the HTML file page (decided by
`Sec-Fetch-Dest: document`, or `Accept: text/html` for clients that do not send
it). `fetch()`, `<img>` and `<video>` in a browser get the bytes, like curl.

The file page shows commands to copy. The file name and link in them come from
the uploader, so they are shell quoted there, and the name alone is used as the
output file.

Uploads are served back with `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff` unless they are a type the browser can safely
render in place (images other than SVG, video, audio, `text/plain`), so an
uploaded HTML file cannot run script on the worker's origin. Files and file
pages are sent with `X-Robots-Tag: noindex`.

## Layout

```
html/            the two pages, as plain HTML with {{TOKEN}} placeholders
  index.html       landing page: drag & drop upload, optional PGP encryption
  access.html      what a browser sees for an uploaded file, with PGP decryption
public/assets/   static files for the pages, served by Cloudflare directly
  index.js         landing page script: drop, paste, encrypt, upload
  access.js        file page script: download and decrypt
  openpgp.min.js   OpenPGP.js, pinned by an integrity hash (see NOTICE.md)
  style.css, fonts/
src/
  index.ts         entry point and routing
  upload.ts        PUT/POST: validation, form uploads, storing the object
  download.ts      GET/HEAD: ranges, conditional requests, download headers
  pages.ts         fills the HTML templates
  templates.ts     single pass {{TOKEN}} substitution
  escape.ts        HTML, JSON-in-script and shell escaping
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

The pages load nothing from other sites: scripts, stylesheet and fonts are in
`public/assets` (the `[assets]` directory in `wrangler.toml`), and the page
Content-Security-Policy allows scripts from this origin only, none inline.

## Development

```sh
npm ci             # installs exactly what package-lock.json pins
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

### Continuous deployment

CI (`.github/workflows/ci.yml`) installs the dependencies pinned in
`package-lock.json`, runs the type check and tests on every pull request and
push, and deploys `main` with `wrangler deploy` once they pass. It
can also be run by hand from the Actions tab (`workflow_dispatch`). It needs two
repository secrets:

- `CLOUDFLARE_API_TOKEN`: an account-owned API token (Manage Account > Account
  API Tokens) scoped to Specified Workers > `transfr-cf` with the Editor role.
  If a Worker-scoped token can't be created, use one with Account > Workers
  Scripts: Edit instead. Routes are mapped on the dashboard, so no zone
  permission is needed.
- `CLOUDFLARE_ACCOUNT_ID`: the account ID, shown on the Workers overview page.

The worker name in `wrangler.toml` (`transfr-cf`) has to match the deployed
worker, or a deploy creates a second worker instead of updating it.

### Configuration

Variables in `wrangler.toml` under `[vars]`:

| Variable                 | Default    | Description                                                     |
| ------------------------ | ---------- | --------------------------------------------------------------- |
| `R2_DEFAULT_NAMESPACE`   | –          | Name of the R2 binding to store files in (required).            |
| `R2_MAX_FILE_SIZE_BYTES` | `21000000` | Largest accepted upload with a `Content-Length`; streamed straight to R2. |
| `R2_MAX_BUFFERED_FILE_SIZE_BYTES` | `21000000` | Largest upload without a `Content-Length` (chunked) or sent as a form, both of which are buffered in memory. Capped at `R2_MAX_FILE_SIZE_BYTES`. |
| `R2_DEFAULT_FILE_TTL`    | `86400`    | File lifetime in seconds.                                       |
| `RAW_ONLY_HOSTS`         | –          | Hosts that always serve bytes, never the HTML page, e.g. for embedding. |

An invalid value is a startup error rather than a silently ignored limit.

R2 has to know an object's size before it stores it. An upload with a
`Content-Length` (browsers, `curl --upload-file`, `curl --data-binary @file`)
streams through the worker into R2, so its limit is not bounded by the Worker's
128 MB of memory. Cloudflare itself rejects request bodies over 100 MB on the
Free plan (200 MB Business, 500 MB Enterprise), so that is the practical
ceiling for `R2_MAX_FILE_SIZE_BYTES`; `wrangler.toml` sets it to 100 MB. A
chunked upload (`curl -T -`) has no length, so it is read into memory first and
gets the lower `R2_MAX_BUFFERED_FILE_SIZE_BYTES`.
