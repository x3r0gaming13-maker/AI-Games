// Vercel serverless HTML browsing endpoint for Nebula.
// This is a best-effort HTML proxy, not a full browser engine. Many sites block proxying
// or depend on browser features that cannot be reproduced by fetching HTML on a server.
import dns from "node:dns/promises";
import net from "node:net";

function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === "::1" ? false :
      !(v === "::" || v.startsWith("fc") || v.startsWith("fd") ||
        v.startsWith("fe8") || v.startsWith("fe9") ||
        v.startsWith("fea") || v.startsWith("feb") ||
        v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") ||
        v.startsWith("::ffff:192.168."));
  }
  return false;
}

async function validatePublicHost(url) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      host.endsWith(".test") || host.endsWith(".invalid")) {
    throw new Error("Local or reserved hostnames are not allowed.");
  }
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new Error("Private network addresses are not allowed.");
    return;
  }
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error("The host does not resolve exclusively to public IP addresses.");
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Method not allowed");
  }

  let target;
  try {
    target = new URL(typeof req.query?.url === "string" ? req.query.url : "");
  } catch {
    return res.status(400).send("Provide a valid URL using http or https.");
  }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    return res.status(400).send("Only public http(s) URLs are supported.");
  }

  try {
    let upstream;
    let current = target;
    for (let redirects = 0; redirects <= 5; redirects++) {
      await validatePublicHost(current);
      upstream = await fetch(current, {
        redirect: "manual",
        headers: {
          "Accept": "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 (compatible; NebulaProxy/1.0)"
        },
        signal: AbortSignal.timeout(12000)
      });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get("location");
      if (!location || redirects === 5) {
        return res.status(502).send("The website redirected too many times.");
      }
      current = new URL(location, current);
      if (!["http:", "https:"].includes(current.protocol) || current.username || current.password) {
        return res.status(400).send("Unsafe redirect blocked.");
      }
    }

    if (!upstream || !upstream.ok) {
      return res.status(502).send("The destination site could not be loaded by Nebula.");
    }
    const type = upstream.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      return res.status(415).send("Nebula's viewer currently supports HTML pages only. Open this destination in a new tab instead.");
    }

    let html = await upstream.text();
    if (html.length > 2_000_000) {
      return res.status(413).send("This page is too large for Nebula's viewer.");
    }
    const base = current.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const bridge = `<base href="${base}"><script>
(function(){
  function proxyUrl(url){try{return '/api/browse?url='+encodeURIComponent(new URL(url,document.baseURI).href)}catch(e){return null}}
  document.addEventListener('click',function(e){
    const a=e.target.closest&&e.target.closest('a[href]');
    if(!a||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||a.target==='_blank')return;
    const next=proxyUrl(a.href);if(next){e.preventDefault();location.href=next}
  },true);
  document.addEventListener('submit',function(e){
    const f=e.target;if(!f||!f.action)return;
    const next=proxyUrl(f.action);if(next){e.preventDefault();location.href=next}
  },true);
})();
</script>`;
    if (/<head(?:\s[^>]*)?>/i.test(html)) {
      html = html.replace(/<head(?:\s[^>]*)?>/i, (match) => match + bridge);
    } else {
      html = "<!doctype html><head>" + bridge + "</head>" + html;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'; object-src 'none'; base-uri https: http:; form-action https: http:");
    return res.status(200).send(html);
  } catch (error) {
    const message = error?.name === "TimeoutError"
      ? "The destination site took too long to respond."
      : "Nebula could not safely load this website. It may be blocked or unsupported.";
    return res.status(502).send(message);
  }
}
