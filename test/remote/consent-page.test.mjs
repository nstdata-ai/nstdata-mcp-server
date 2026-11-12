import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { remoteCli as cli } from '../helpers.mjs';

const { renderConsentPage, renderConsentError, renderCallbackPage, consentPageCsp, consentFormCsp } = await import(new URL('./consent-page.js', pathToFileURL(cli)));
const options = {
    action: '/oauth/interaction/synthetic-interaction',
    csrf: 'synthetic-csrf',
    client: { id: 'synthetic-client', name: 'MCP client', callbackOrigin: 'https://client.fixture.test' },
};

test('consent form preserves the native authorization and cancellation contract', () => {
    const html = renderConsentPage(options);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
    assert.match(html, /<form method="post" action="\/oauth\/interaction\/synthetic-interaction" autocomplete="off">/);
    assert.match(html, /<input type="hidden" name="csrf" value="synthetic-csrf">/);
    assert.match(html, /<h1 id="page-title">Connect Nstdata Crawl<\/h1>/);
    assert.match(html, /After authorization, return to <strong>MCP client<\/strong>/);
    assert.match(html, /<label for="api-token">Nstdata Crawl API key<\/label>/);
    const key = html.match(/<input id="api-token"[^>]*>/)?.[0];
    assert.ok(key);
    assert.match(key, /name="apiToken" type="password" required/);
    assert.match(key, /autocomplete="off" autocapitalize="none" spellcheck="false"/);
    assert.match(key, /aria-describedby="api-token-help"/);
    assert.doesNotMatch(key, /\bvalue=/);
    assert.match(html, /name="decision" value="allow" type="submit">Authorize<\/button>/);
    assert.match(html, /name="decision" value="deny" type="submit" formnovalidate>Cancel<\/button>/);
    assert.match(html, /href="https:\/\/app\.nstdata\.io\/" target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /Crawl usage is charged to the account linked to this key/);
    assert.match(html, /Access can be renewed until this authorization expires or is revoked/);
    assert.doesNotMatch(html, /<script\b|<iframe\b|<img\b|<link\b|\son\w+=/i);
});

test('all client, form and error text is escaped without repopulating the API key', () => {
    const value = `"><script>alert('x')</script>&`;
    const escaped = '&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;';
    const html = renderConsentPage({ action: value, csrf: value,
        client: { id: value, name: value, callbackOrigin: value }, error: value });
    assert.equal(html.split(escaped).length - 1, 7);
    assert.doesNotMatch(html, /<script\b/i);
    assert.match(html, /id="consent-error" class="alert" role="alert"/);
    const key = html.match(/<input id="api-token"[^>]*>/)?.[0];
    assert.ok(key);
    assert.match(key, /aria-describedby="api-token-help consent-error"/);
    assert.doesNotMatch(key, /\bvalue=/);
});

test('client details retain complete long identifiers without forcing a single line', () => {
    const id = `https://client.fixture.test/${'long-client-id-'.repeat(30)}`;
    const callbackOrigin = `https://${'callback-'.repeat(25)}fixture.test`;
    const html = renderConsentPage({ ...options, client: { ...options.client, id, callbackOrigin } });
    assert.ok(html.includes(`<dt>Client ID</dt><dd><code>${id}</code></dd>`));
    assert.ok(html.includes(`<p class="callback">Return address: <code>${callbackOrigin}</code></p>`));
    assert.match(html, /<details>\s*<summary>Application details<\/summary>/);
    assert.match(html, /Application name supplied by its developer/);
    assert.ok(html.indexOf('Application name supplied by its developer') < html.indexOf('<details>'));
    assert.ok(html.indexOf(callbackOrigin) < html.indexOf('<details>'));
    const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    assert.ok(css.includes('overflow-wrap:anywhere'));
    assert.doesNotMatch(css, /(?:main|code|dd)[^{]*\{[^}]*white-space:nowrap/);
});

test('both page types use the exact hashed CSS with no script or external resource permission', () => {
    for (const html of [renderConsentPage(options), renderConsentError({ title: 'Request expired', message: 'Restart the connection from your MCP client.' })]) {
        const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
        assert.equal(styles.length, 1);
        const hash = createHash('sha256').update(styles[0][1]).digest('base64');
        assert.equal(consentPageCsp, `default-src 'none'; style-src 'sha256-${hash}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
        assert.doesNotMatch(html, /\sstyle=|<script\b|<link\b|<img\b/i);
    }
});

test('expired and rejected interactions render actionable escaped text without a form', () => {
    const html = renderConsentError({ title: 'Request <expired>', message: 'Restart from your MCP client. "<script>"' });
    assert.match(html, /<h1 id="page-title">Request &lt;expired&gt;<\/h1>/);
    assert.match(html, /Restart from your MCP client\. &quot;&lt;script&gt;&quot;/);
    assert.match(html, /role="alert"/);
    assert.doesNotMatch(html, /<form\b|<input\b|<button\b|<script\b|synthetic-client|synthetic-csrf/i);
});

test('consent permits only the validated callback origin while retaining every other policy', () => {
    for (const uri of ['http://127.0.0.1:52767/callback?state=not-a-policy', 'https://client.fixture.test/callback']) {
        const policy = consentFormCsp(uri);
        assert.equal(policy, consentPageCsp.replace("form-action 'self'", `form-action 'self' ${new URL(uri).origin}`));
        assert.doesNotMatch(policy, /state=|unsafe-inline|\*/);
    }
    for (const uri of ['javascript:alert(1)', 'data:text/plain,example', 'not a URL']) assert.throws(() => consentFormCsp(uri));
    assert.equal(consentFormCsp('http://[::1]:52767/callback'), consentPageCsp);
    assert.match(consentPageCsp, /form-action 'self';/);
});

test('IPv6 return page preserves the callback in escaped navigation and fallback without scripts', () => {
    const uri = 'http://[::1]:52767/callback?code=synthetic&state=%22%3E%3Cscript%3E&iss=https%3A%2F%2Fissuer.invalid';
    const html = renderCallbackPage(uri), escaped = uri.replaceAll('&', '&amp;');
    assert(html.includes(`<meta http-equiv="refresh" content="0;url=${escaped}">`));
    assert(html.includes(`<a href="${escaped}">continue to your application</a>`));
    assert.doesNotMatch(html, /<form\b|<input\b|<script\b|\son\w+=/i);
    for (const value of ['javascript:alert(1)', 'data:text/html,example', 'http://user:password@[::1]/']) assert.throws(() => renderCallbackPage(value));
});
