import { createHash } from 'node:crypto';

const css = `:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222637;background:#f5f6f9;font-synthesis:none}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;padding:24px 20px;display:flex;align-items:center;justify-content:center;font-size:15px;line-height:1.55}
main{width:100%;max-width:480px;min-width:0;padding:28px;background:#fff;border:1px solid #e3e5ec;border-radius:12px;overflow-wrap:anywhere}
.brand{margin:0 0 20px;color:#5146c9;font-size:21px;font-weight:750;letter-spacing:-.6px}
h1{margin:0 0 10px;font-size:27px;line-height:1.2;font-weight:650;letter-spacing:-.7px}
p{margin:0}
.intro,.help,.scope,.next-step{color:#5b6072}
strong{color:#222637;font-weight:600}
.scope{margin:18px 0 22px;padding:14px 0;border-top:1px solid #e9eaf0;border-bottom:1px solid #e9eaf0;font-size:14px}
.scope p+p{margin-top:8px}
label{display:block;margin:0 0 8px;font-size:14px;font-weight:600}
input[type=password]{display:block;width:100%;min-width:0;min-height:46px;padding:11px 12px;border:1px solid #8b91a2;border-radius:6px;background:#fff;color:#222637;font:inherit}
.help{margin-top:8px;font-size:13px}
a{color:#473ab5;text-underline-offset:3px}
a:hover{color:#31257e}
.confirm{display:flex;gap:10px;align-items:flex-start;margin:20px 0 0;font-size:14px;font-weight:400;cursor:pointer}
input[type=checkbox]{flex:none;width:18px;height:18px;margin:3px 0 0;accent-color:#5146c9}
.actions{display:flex;gap:10px;margin-top:20px}
button{width:100%;min-height:44px;padding:11px 18px;border:1px solid #5146c9;border-radius:6px;background:#5146c9;color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
button:hover{border-color:#4237b2;background:#4237b2}
:focus-visible{outline:3px solid #7164df;outline-offset:3px}
.access-note{margin-top:14px;color:#666b7c;font-size:12px;line-height:1.5}
.alert{margin:0 0 20px;padding:12px 14px;border:1px solid #edc8ca;border-radius:6px;background:#fff5f5;color:#982b31;font-size:14px}
.next-step{margin-top:18px;font-size:14px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:480px){body{padding:24px 16px}main{padding:24px 22px}h1{font-size:25px}}
@media(max-height:700px){body{align-items:flex-start}}`;

export const authorizationPageCsp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;

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

const scope = `<div class="scope" id="revocation-scope">
<p><strong>All MCP OAuth connections authorized with this key will be revoked.</strong> This revokes every MCP OAuth authorization created with the API key you enter.</p>
<p>Your API key stays active. Your Nstdata account and authorizations created with other API keys are not changed.</p>
</div>`;

export function renderAuthorizationPage({ action, csrf, error }: {
    action: string;
    csrf: string;
    error?: string;
}): string {
    return frame('Revoke MCP access', `<h1 id="page-title">Revoke MCP access</h1>
<p class="intro">Disconnect MCP applications from Nstdata Crawl using your API key.</p>
${scope}
${error ? `<p id="authorization-error" class="alert" role="alert">${escape(error)}</p>` : ''}
<form method="post" action="${escape(action)}" autocomplete="off" aria-describedby="revocation-scope">
<input type="hidden" name="csrf" value="${escape(csrf)}">
<label for="api-token">Nstdata Crawl API key</label>
<input id="api-token" name="apiToken" type="password" required autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="api-token-help${error ? ' authorization-error' : ''}">
<p id="api-token-help" class="help">Enter the key used to authorize your MCP applications. Find it in the <a href="https://app.nstdata.io/" target="_blank" rel="noopener noreferrer">Nstdata dashboard<span class="sr-only"> (opens in a new tab)</span></a>.</p>
<label class="confirm" for="confirm-revocation"><input id="confirm-revocation" name="confirm" type="checkbox" value="revoke-all" required><span>I understand this disconnects all MCP applications authorized with this API key.</span></label>
<div class="actions"><button name="decision" value="revoke" type="submit">Revoke MCP access</button></div>
<p class="access-note">To cancel, close this page and return to your MCP client. Access changes only when you select Revoke MCP access.</p>
</form>`);
}

export function renderAuthorizationResult({ outcome, message }: {
    outcome: 'revoked' | 'already-revoked' | 'error';
    message?: string;
}): string {
    const title = outcome === 'revoked' ? 'MCP access revoked' : outcome === 'already-revoked' ? 'No active MCP access' : 'Could not revoke MCP access';
    const description = outcome === 'revoked'
        ? 'All MCP OAuth authorizations created with this API key have been revoked.'
        : outcome === 'already-revoked'
            ? 'There are no active MCP OAuth authorizations created with this API key.'
            : 'We could not confirm that MCP access was revoked. Please try again.';
    return frame(title, `<h1 id="page-title">${title}</h1>
<p class="${outcome === 'error' ? 'alert' : 'intro'}"${outcome === 'error' ? ' role="alert"' : ''}>${escape(message ?? description)}</p>
${outcome === 'error' ? '<p class="next-step"><a href="/oauth/authorizations">Start a new revocation request</a>.</p>' : '<p class="next-step">Your API key stays active. Your Nstdata account and authorizations created with other API keys are not changed.</p>'}
<p class="next-step">Return to your MCP client&#39;s connection settings. To grant access again, reconnect to Nstdata from there and authorize with your API key.</p>`);
}
