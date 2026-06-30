// Same-origin guard for the runtime-loaded STT engine module.
//
// The STT worker dynamic-import()s the `?sttEngine=` URL and then feeds it real
// microphone audio. A remote origin — a shared or mistyped link — would run
// attacker-controlled worker code on live speech, breaking the plan's
// on-device / no-egress guarantee. So the engine module is restricted to
// self-hosted, same-origin URLs: relative paths and absolute URLs whose origin
// equals the page/worker origin are allowed; everything else (remote http(s),
// blob:, data:, file:, javascript:, unparseable) is rejected BEFORE the worker
// imports it.
//
// Operator decision (su-0hi #1): RESTRICT the engine URL; do NOT re-scope the
// no-egress guarantee. There is intentionally no remote-origin escape hatch — to
// host the engine elsewhere, serve it from the app's own origin (e.g. a
// same-origin reverse-proxy path).

/**
 * Return the engine URL when it is same-origin / self-hosted, else `undefined`
 * (the caller drops it and degrades to the labelled stub).
 *
 * @param url  candidate engine module URL (from `?sttEngine=` or `opts.engineUrl`)
 * @param base trusted origin to resolve + compare against — the page or worker
 *             `location.href`. Relative `url`s resolve against it.
 */
export function sanitizeEngineUrl(url: string | undefined | null, base: string): string | undefined {
  if (!url) return undefined;

  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return undefined; // no trustworthy origin to compare against → fail closed
  }

  let resolved: URL;
  try {
    resolved = new URL(url, baseUrl);
  } catch {
    return undefined; // unparseable → reject
  }

  // Self-hosted web asset only: http(s) AND the page's exact origin. A
  // cross-origin absolute URL, or an opaque-origin scheme (blob:/data:/file:/
  // javascript:), fails one of these checks.
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
  if (resolved.origin !== baseUrl.origin) return undefined;

  return resolved.href;
}
