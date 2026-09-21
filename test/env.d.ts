/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Env as WorkerEnv } from "../src/env"

// `env` from "cloudflare:test" is typed as Cloudflare.Env; describe it with the
// worker's own bindings instead of generating worker-configuration.d.ts.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
