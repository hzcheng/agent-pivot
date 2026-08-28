'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    renderConversationMarkdown,
} = require('../../../out/aiSessions/conversation/markdown');
const {
    normalizeVisibleText,
} = require('../../../out/aiSessions/conversation/text');

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

test('SESSION-AI-SESSION-CONVERSATION-FENCED-CODE-001 renders provider code indented and highlighted after normalization', () => {
    const providerText = [
        '关键实现：',
        '',
        '```python',
        'def execute_tool(name: str) -> str:',
        '    if name == "read_file":',
        '        return read_file(args["path"])',
        '```',
    ].join('\n');
    const html = renderConversationMarkdown(
        normalizeVisibleText(providerText)
    );
    assert.match(html, /<code class="hljs language-python">/);
    assert.match(
        html,
        /\n {4}<span class="hljs-keyword">if<\/span>/,
        'four-space indentation survives into the highlighted code'
    );
    assert.match(
        html,
        /\n {8}<span class="hljs-keyword">return<\/span>/,
        'nested eight-space indentation survives too'
    );
});

test('CONVERSATION-RUN-COMMAND-001 offers Run only for bounded valid shell fences', () => {
    const runnable = renderConversationMarkdown('```bash\npwd\n```');
    const oversized = renderConversationMarkdown(`\`\`\`bash\n${'x'.repeat(4001)}\n\`\`\``);
    const nonShell = renderConversationMarkdown('```typescript\nconsole.log(1)\n```');

    assert.match(runnable, /data-conversation-run-command/);
    assert.doesNotMatch(oversized, /data-conversation-run-command/);
    assert.doesNotMatch(nonShell, /data-conversation-run-command/);
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

test('CONVERSATION-DIFF-VISIBILITY-001 renders diff fences as escaped side-by-side changes', () => {
    const html = renderConversationMarkdown([
        '```diff',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -3 +3 @@',
        '-const value = "old";',
        '+const value = "<new>";',
        '```',
    ].join('\n'));

    assert.match(html, /conversation-diff-grid/);
    assert.match(html, /conversation-diff-side-old conversation-diff-line conversation-diff-line-del/);
    assert.match(html, /conversation-diff-side-new conversation-diff-line conversation-diff-line-add/);
    assert.match(html, /&lt;new&gt;/, 'diff source is escaped before rendering');
    assert.equal(html.includes('<new>'), false);
});
