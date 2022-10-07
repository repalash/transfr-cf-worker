# transfr.one worker

A Cloudflare worker for storing temporary files in KV with a random ID and auto deletion. 

Check it out: https://transfr.one

PUT request to upload file.
GET request on / to get index.html and on path to get the uploaded file.


## Initial Setup

Install [wrangler](https://developers.cloudflare.com/workers/wrangler/get-started/) and login with `wrangler login`.

Create a KV namespace
```sh
wrangler kv:namespace create TEMP_STORE_KV_1
```

Then set the KV namespace name and id in `wrangler.toml` under `kv_namespaces` and environment variables.

Map the route to domain on the Cloudflare dashboard.
