// Optional operator-managed transport. No storage, schedules or open proxy.
export function allowedUrl(value, allowed) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
    if (!["www.ishares.com", "www.blackrock.com"].includes(url.hostname)) return false;
    const dates = url.searchParams.getAll("asOfDate");
    if (dates.length > 1 || (dates.length === 1 && !/^\d{8}$/.test(dates[0]))) return false;
    url.searchParams.delete("asOfDate");
    return allowed.includes(url.toString());
  } catch { return false; }
}

const worker = {
  async fetch(request, env) {
    const fail = (status, code) => new Response(code, {
      status, headers: { "Cache-Control": "no-store", "X-Holdings-Error-Code": code },
    });
    // Cloudflare supplies this header; clients cannot choose the source IP.
    if (!env.ALLOWED_IP || request.headers.get("CF-Connecting-IP") !== env.ALLOWED_IP) {
      return fail(403, "RELAY_FORBIDDEN");
    }
    if (request.method !== "GET") return fail(405, "RELAY_METHOD");
    const incoming = new URL(request.url);
    if (incoming.pathname !== "/") return fail(404, "RELAY_PATH");
    const target = incoming.searchParams.get("url");
    if (!target || !allowedUrl(target, env.ALLOWED_URLS ?? [])) return fail(400, "RELAY_TARGET");
    try {
      const upstream = await fetch(target, {
        headers: {
          Accept: target.includes("/varnish-api/") ? "application/json,*/*;q=0.8" : "text/csv,text/plain;q=0.9,*/*;q=0.8",
          "User-Agent": "WeightingsAnalytics/0.1 holdings-research",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(12_000),
      });
      // Do not follow a redirect outside the allowlist or report HTML as success.
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return fail(502, "UPSTREAM_REDIRECT");
      }
      const headers = new Headers({
        "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      if (!upstream.ok) headers.set("X-Holdings-Error-Code", `HTTP_${upstream.status}`);
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error) {
      return fail(502, error.name === "TimeoutError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK");
    }
  },
};

export default worker;
