'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    renderConversationMarkdown,
} = require('../../../out/aiSessions/conversation/markdown');

test('CONVERSATION-VIEWER-MARKDOWN-001 renders readable Markdown without executable HTML', () => {
    const html = renderConversationMarkdown(`# Heading

- first
- second

\`\`\`js
const answer = 42;
\`\`\`

Plain **strong** text.

<script>window.__executed = true</script>`);

    assert.match(html, /<h1>Heading<\/h1>/);
    assert.match(html, /<ul>[\s\S]*<li>first<\/li>[\s\S]*<li>second<\/li>[\s\S]*<\/ul>/);
    assert.match(html, /<pre><code class="hljs language-js"><span class="hljs-keyword">const<\/span> answer = <span class="hljs-number">42<\/span>;\n<\/code><\/pre>/);
    assert.match(html, /Plain <strong>strong<\/strong> text\./);
    assert.equal(html.includes('<script>'), false);
    assert.match(html, /&lt;script&gt;window\.__executed = true&lt;\/script&gt;/);
});

test('CONVERSATION-VIEWER-MARKDOWN-002 emits href attributes only for HTTPS links', () => {
    const html = renderConversationMarkdown([
        '[safe](https://example.test/path)',
        '[http](http://example.test/path)',
        '[javascript](javascript:alert(1))',
        '[data](data:text/html,unsafe)',
        '[file](file:///tmp/private)',
        '[command](command:workbench.action.reloadWindow)',
    ].join('\n\n'));

    assert.match(html, /href="https:\/\/example\.test\/path"/);
    assert.equal((html.match(/\shref=/g) || []).length, 1);
    assert.match(html, /\[http\]\(http:\/\/example\.test\/path\)/);
    assert.match(html, /\[javascript\]\(javascript:alert\(1\)\)/);
});

test('CONVERSATION-VIEWER-MARKDOWN-003 emits rich content only with safe image sources', () => {
    const html = renderConversationMarkdown([
        '![safe icon](https://example.test/icon.svg "Status")',
        '',
        '![unsafe icon](data:image/svg+xml,unsafe)',
        '',
        '| State | Result |',
        '| --- | --- |',
        '| Build | Ready |',
        '',
        '```mermaid',
        'flowchart LR',
        '    A --> B',
        '```',
    ].join('\n'));

    assert.match(
        html,
        /<img src="https:\/\/example\.test\/icon\.svg" alt="safe icon" title="Status">/
    );
    assert.equal((html.match(/<img /g) || []).length, 1);
    assert.match(html, /<table>[\s\S]*<th>State<\/th>[\s\S]*<td>Ready<\/td>/);
    assert.match(
        html,
        /<pre><code class="hljs language-mermaid">flowchart LR\n    A --&gt; B\n<\/code><\/pre>/
    );
});
