// Route Node's global fetch (undici) through an HTTP/HTTPS proxy when one is
// configured in the environment.
//
// Unlike curl and the rest of the system, Node's built-in fetch ignores the
// standard *_PROXY environment variables. On machines that block direct egress
// and require a local proxy (e.g. a Clash / V2Ray client on 127.0.0.1), every
// YouTube Data API request therefore fails at the TCP layer with the opaque
// "fetch failed" (UND_ERR_CONNECT_TIMEOUT) error, which is exactly what broke
// collection.
//
// Reading the proxy from the environment — and thus from .env via dotenv — also
// makes scheduled collection work: a macOS launchd job does NOT inherit the
// shell environment, so HTTPS_PROXY exported in a terminal is invisible to it.
// Setting SNS_HTTPS_PROXY in .env is picked up on every code path (manual CLI,
// the web backend's subprocess, and launchd) because they all load .env.

function selectProxyUrl() {
  const candidate =
    process.env.SNS_HTTPS_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    "";
  return candidate.trim();
}

let configuredProxy = null;

// Configure the global fetch dispatcher to use the environment proxy, if any.
// Idempotent and best-effort: a missing undici or an invalid URL leaves fetch
// untouched rather than crashing the engine. Returns the proxy URL that was
// applied, or null when no proxy is configured / available.
export async function configureProxyFromEnv() {
  if (configuredProxy) {
    return configuredProxy;
  }
  const proxyUrl = selectProxyUrl();
  if (!proxyUrl) {
    return null;
  }
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    configuredProxy = proxyUrl;
    return proxyUrl;
  } catch {
    return null;
  }
}
