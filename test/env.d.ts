declare namespace Cloudflare {
  interface Env {
    BOARD: DurableObjectNamespace<import("../src/board").Board>;
  }
}
