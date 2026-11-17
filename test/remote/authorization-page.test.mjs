import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { remoteCli as cli } from '../helpers.mjs';

const { renderAuthorizationPage, renderAuthorizationResult, authorizationPageCsp } = await import(new URL('./authorization-page.js', pathToFileURL(cli)));
const options = { action: '/oauth/authorizations', csrf: 'synthetic-csrf' };

test('revocation form requires an API key and explicit confirmation of the complete same-key scope', () => {
    const html = renderAuthorizationPage(options);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
    assert.match(html, /<main aria-labelledby="page-title">/);
    assert.match(html, /<h1 id="page-title">Revoke MCP access<\/h1>/);
    assert.match(html, /<form method="post" action="\/oauth\/authorizations" autocomplete="off" aria-describedby="revocation-scope">/);
    assert.match(html, /<input type="hidden" name="csrf" value="synthetic-csrf">/);
    assert.match(html, /This revokes every MCP OAuth authorization created with the API key you enter/);
    assert.match(html, /Your API key stays active/);
    assert.match(html, /Your Nstdata account and authorizations created with other API keys are not changed/);
    assert.ok(html.indexOf('All MCP OAuth connections authorized with this key will be revoked') < html.indexOf('<form'));
    const key = html.match(/<input id="api-token"[^>]*>/)?.[0];
    assert.ok(key);
    assert.match(html, /<label for="api-token">Nstdata Crawl API key<\/label>/);
    assert.match(key, /name="apiToken" type="password" required/);
    assert.match(key, /autocomplete="off" autocapitalize="none" spellcheck="false"/);
    assert.match(key, /aria-describedby="api-token-help"/);
    assert.doesNotMatch(key, /\bvalue=/);
    assert.match(html, /<label class="confirm" for="confirm-revocation">/);
    const confirm = html.match(/<input id="confirm-revocation"[^>]*>/)?.[0];
    assert.ok(confirm);
    assert.match(confirm, /name="confirm" type="checkbox" value="revoke-all" required/);
    assert.doesNotMatch(confirm, /\bchecked\b/);
    assert.match(html, /I understand this disconnects all MCP applications authorized with this API key/);
    assert.match(html, /<button name="decision" value="revoke" type="submit">Revoke MCP access<\/button>/);
    assert.match(html, /To cancel, close this page and return to your MCP client/);
    assert.match(html, /href="https:\/\/app\.nstdata\.io\/" target="_blank" rel="noopener noreferrer"/);
});

test('form values and errors are escaped and neither credentials nor confirmation are repopulated', () => {
    const value = `"><script>alert('x')</script>&`;
    const escaped = '&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;';
    const html = renderAuthorizationPage({ action: value, csrf: value, error: value, apiToken: 'synthetic-secret-never-echo' });
    assert.equal(html.split(escaped).length - 1, 3);
    assert.match(html, /id="authorization-error" class="alert" role="alert"/);
    assert.match(html, /aria-describedby="api-token-help authorization-error"/);
    assert.doesNotMatch(html, /<script\b|synthetic-secret-never-echo/i);
    assert.doesNotMatch(html.match(/<input id="api-token"[^>]*>/)?.[0], /\bvalue=/);
    assert.doesNotMatch(html.match(/<input id="confirm-revocation"[^>]*>/)?.[0], /\bchecked\b/);
});

test('success and already-revoked results explain the outcome and how to reconnect from the client', () => {
    for (const outcome of ['revoked', 'already-revoked']) {
        const html = renderAuthorizationResult({ outcome, apiToken: 'synthetic-secret-never-echo' });
        assert.match(html, outcome === 'revoked' ? /All MCP OAuth authorizations created with this API key have been revoked/ : /There are no active MCP OAuth authorizations created with this API key/);
        assert.match(html, /Your API key stays active/);
        assert.match(html, /authorizations created with other API keys are not changed/);
        assert.match(html, /Return to your MCP client&#39;s connection settings/);
        assert.match(html, /reconnect to Nstdata from there and authorize with your API key/);
        assert.doesNotMatch(html, /<form\b|<input\b|<button\b|http-equiv="refresh"|synthetic-secret-never-echo|href="\/oauth\/(?:authorize|interaction)/i);
    }
});

test('failure results do not claim revocation and offer a fresh form and client recovery instructions', () => {
    const html = renderAuthorizationResult({ outcome: 'error' });
    assert.match(html, /Could not revoke MCP access/);
    assert.match(html, /class="alert" role="alert"/);
    assert.match(html, /We could not confirm that MCP access was revoked/);
    assert.match(html, /href="\/oauth\/authorizations">Start a new revocation request/);
    assert.match(html, /Return to your MCP client&#39;s connection settings/);
    assert.doesNotMatch(html, /<form\b|<input\b|<button\b/);
    const escaped = renderAuthorizationResult({ outcome: 'error', message: `Request <expired> "don't retry" & restart.` });
    assert.match(escaped, /Request &lt;expired&gt; &quot;don&#39;t retry&quot; &amp; restart\./);
});

test('all pages use the exact hashed CSS with no scripts, external resources or automatic redirects', () => {
    const pages = [renderAuthorizationPage(options), renderAuthorizationPage({ ...options, error: 'Invalid key' }), ...['revoked', 'already-revoked', 'error'].map(outcome => renderAuthorizationResult({ outcome }))];
    for (const html of pages) {
        const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
        assert.equal(styles.length, 1);
        const hash = createHash('sha256').update(styles[0][1]).digest('base64');
        assert.equal(authorizationPageCsp, `default-src 'none'; style-src 'sha256-${hash}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
        assert.doesNotMatch(html, /\sstyle=|<script\b|<link\b|<img\b|<iframe\b|\son\w+=|http-equiv="refresh"/i);
        assert.match(styles[0][1], /overflow-wrap:anywhere/);
        assert.match(styles[0][1], /:focus-visible\{/);
        assert.match(styles[0][1], /@media\(max-width:480px\)/);
    }
});
