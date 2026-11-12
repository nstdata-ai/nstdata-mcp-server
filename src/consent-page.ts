import { createHash } from 'node:crypto';

const css = `:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222637;background:#f5f6f9;font-synthesis:none}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;padding:24px 20px;display:flex;align-items:center;justify-content:center;font-size:15px;line-height:1.55}
main{width:100%;max-width:480px;min-width:0;padding:28px;background:#fff;border:1px solid #e3e5ec;border-radius:12px;overflow-wrap:anywhere}
.brand{margin:0 0 20px;color:#5146c9;font-size:21px;font-weight:750;letter-spacing:-.6px}
h1{margin:0 0 10px;font-size:27px;line-height:1.2;font-weight:650;letter-spacing:-.7px}
p{margin:0}
.intro,.error-message{color:#5b6072}
strong{color:#222637;font-weight:600}
.client-note,.callback{margin-top:6px;color:#5b6072;font-size:13px}
.permissions{margin:18px 0 0;padding:14px 0;list-style:none;border-top:1px solid #e9eaf0;border-bottom:1px solid #e9eaf0;font-size:14px}
.permissions li+li{margin-top:8px}
.permissions span{color:#5b6072}
details{margin:14px 0 22px;font-size:13px}
summary{width:fit-content;max-width:100%;cursor:pointer;color:#4b5063;font-weight:600}
details[open] summary{margin-bottom:14px}
dl{margin:0}
dt{margin-top:10px;color:#5b6072;font-size:12px}
dd{margin:3px 0 0;min-width:0;color:#222637}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
.trust-note{margin-top:14px;color:#5b6072;line-height:1.5}
label{display:block;margin:0 0 8px;font-size:14px;font-weight:600}
input[type=password]{display:block;width:100%;min-width:0;min-height:46px;padding:11px 12px;border:1px solid #8b91a2;border-radius:6px;background:#fff;color:#222637;font:inherit}
.help{margin-top:8px;color:#5b6072;font-size:13px}
a{color:#473ab5;text-underline-offset:3px}
a:hover{color:#31257e}
.actions{display:flex;gap:10px;margin-top:20px}
button{min-height:44px;padding:11px 18px;border:1px solid #d3d6e0;border-radius:6px;background:#fff;color:#42485d;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#f5f6f9;border-color:#a7acbb}
.primary{flex:1;border-color:#5146c9;background:#5146c9;color:#fff}
.primary:hover{border-color:#4237b2;background:#4237b2}
:focus-visible{outline:3px solid #7164df;outline-offset:3px}
.access-note{margin-top:14px;color:#666b7c;font-size:12px;line-height:1.5}
.alert{margin:0 0 20px;padding:12px 14px;border:1px solid #edc8ca;border-radius:6px;background:#fff5f5;color:#982b31;font-size:14px}
.error-message{margin-top:16px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:480px){body{padding:24px 16px}main{padding:24px 22px}h1{font-size:25px}}
@media(max-height:700px){body{align-items:flex-start}}`;

export const consentPageCsp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

function frame(title: string, content: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Nstdata</title>
<style>${css}</style>
</head>
<body><main aria-labelledby="page-title">
<p class="brand">Nstdata</p>
${content}
</main></body>
</html>`;
}

export function renderConsentPage({ action, csrf, client, error }: {
    action: string;
    csrf: string;
    client: { id: string; name: string; callbackOrigin: string };
    error?: string;
}): string {
    return frame('Connect Nstdata Crawl', `<h1 id="page-title">Connect Nstdata Crawl</h1>
<p class="intro"><strong>${escape(client.name)}</strong> is requesting access to Nstdata Crawl.</p>
<p class="client-note">Application name supplied by its developer.</p>
<p class="callback">After authorization, return to <strong>${escape(client.name)}</strong>.</p>
<p class="callback">Return address: <code>${escape(client.callbackOrigin)}</code></p>
<ul class="permissions" aria-label="Requested access">
<li><strong>Crawl access.</strong> <span>Scrape pages, run crawls, and read results.</span></li>
<li><strong>Usage charges.</strong> <span>Crawl usage is charged to the account linked to this key.</span></li>
</ul>
<details>
<summary>Application details</summary>
<dl>
<dt>Client ID</dt><dd><code>${escape(client.id)}</code></dd>
</dl>
<p class="trust-note">Check the client ID and return address before authorizing.</p>
</details>
${error ? `<p id="consent-error" class="alert" role="alert">${escape(error)}</p>` : ''}
<form method="post" action="${escape(action)}" autocomplete="off">
<input type="hidden" name="csrf" value="${escape(csrf)}">
<label for="api-token">Nstdata Crawl API key</label>
<input id="api-token" name="apiToken" type="password" required autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="api-token-help${error ? ' consent-error' : ''}">
<p id="api-token-help" class="help">Get your key from the <a href="https://app.nstdata.io/" target="_blank" rel="noopener noreferrer">Nstdata dashboard<span class="sr-only"> (opens in a new tab)</span></a>.</p>
<div class="actions">
<button class="primary" name="decision" value="allow" type="submit">Authorize</button>
<button name="decision" value="deny" type="submit" formnovalidate>Cancel</button>
</div>
<p class="access-note">Access can be renewed until this authorization expires or is revoked. Only authorize an application you trust.</p>
</form>`);
}

export function renderConsentError({ title, message }: { title: string; message: string }): string {
    return frame(title, `<div role="alert">
<h1 id="page-title">${escape(title)}</h1>
<p class="error-message">${escape(message)}</p>
</div>`);
}
