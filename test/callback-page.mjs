import assert from 'node:assert/strict';

// Parse the browser-visible response, including its security headers, rather than inventing a Location.
export async function callbackFromResponse(response, checkContent = () => {}) {
    assert.equal(response.status, 200, 'the application return page ends the form redirect chain');
    const headers = new Headers(response.headers);
    assert.equal(headers.get('location'), null);
    assert.match(headers.get('content-type'), /^text\/html/);
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
    assert.equal(headers.get('content-security-policy').split(';').map(value => value.trim()).find(value => value.startsWith('form-action ')), "form-action 'self'");
    const html = typeof response.text === 'function' ? await response.text() : response.body;
    checkContent(html);
    const target = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(html)?.[1];
    assert(target, 'the final response provides a navigation bridge');
    assert(html.includes(`<a href="${target}">continue to your application</a>`), 'the fallback uses the same complete callback');
    assert.doesNotMatch(html, /<form\b|<input\b|<script\b|\son\w+=/i);
    return new URL(target.replace(/&(amp|quot|lt|gt|#39);/g, (_, entity) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[entity]));
}
