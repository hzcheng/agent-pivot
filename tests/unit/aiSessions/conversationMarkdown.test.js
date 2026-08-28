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
    assert.match(html, /<table class="conversation-data-table" data-conversation-table-id="0">[\s\S]*data-conversation-sort-column="0"[\s\S]*<td class="">Ready<\/td>/);
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
    assert.match(html, /data-conversation-diff-context-toggle/);
    assert.match(html, /&lt;new&gt;/, 'diff source is escaped before rendering');
    assert.equal(html.includes('<new>'), false);
});

test('CONVERSATION-RICH-MARKDOWN-004 renders task lists, callouts, and bounded bar charts as controlled markup', () => {
    const html = renderConversationMarkdown([
        '- [x] done',
        '- [ ] pending',
        '',
        '> [!WARNING]',
        '> Check the migration.',
        '',
        '```chart',
        '{"title":"Results","labels":["Pass","Fail"],"values":[9,1]}',
        '```',
    ].join('\n'));

    assert.match(html, /conversation-task-checkbox-checked/);
    assert.match(html, /conversation-task-state">Completed<\/span>/);
    assert.match(html, /conversation-task-state">Not completed<\/span>/);
    assert.match(html, /conversation-callout-warning/);
    assert.match(html, /conversation-chart conversation-chart-bar" role="group"/);
    assert.match(html, /<progress class="conversation-chart-progress" max="100" value="100" aria-hidden="true">/);
});

test('CONVERSATION-RICH-MARKDOWN-005 renders workspace references, folded structured data, math, and bounded SVG charts', () => {
    const html = renderConversationMarkdown([
        'Inspect src/aiSessions/conversation/markdown.ts:42, packages/app/index.ts, and [the viewer](src/aiSessions/conversation/viewer.ts#L20).',
        '',
        '```json',
        '{"answer":42,"nested":{"safe":true}}',
        '```',
        '',
        'Inline $x^2 + y^2$ is supported.',
        '',
        '$$',
        '\\frac{1}{2}',
        '$$',
        '',
        '```chart',
        '{"type":"line","labels":["One","Two"],"values":[1,3]}',
        '```',
        '',
        '```pie-chart',
        '{"labels":["Pass","Fail"],"values":[9,1]}',
        '```',
    ].join('\n'));

    assert.match(html, /href="src\/aiSessions\/conversation\/markdown\.ts:42"/);
    assert.match(html, /href="packages\/app\/index\.ts"/);
    assert.match(html, /href="src\/aiSessions\/conversation\/viewer\.ts#L20"/);
    assert.match(html, /conversation-structured-block/);
    assert.match(html, /hljs-attr">&quot;answer&quot;<\/span>/);
    assert.match(html, /conversation-math/);
    assert.match(html, /conversation-math-source">Math: x\^2 \+ y\^2<\/span>/,
        'the source expression remains available to assistive technology');
    assert.match(html, /conversation-chart-line/);
    assert.match(html, /<polyline /);
    assert.match(html, /conversation-chart-pie/);
    assert.match(html, /<circle /);
});

test('CONVERSATION-RICH-MARKDOWN-008 preserves prose, task-list structure, and bounded math rendering', () => {
    const looseTasks = renderConversationMarkdown([
        '- [x] parent',
        '',
        '  - [ ] child',
        '',
        '- [ ] pending',
    ].join('\n'));
    assert.equal((looseTasks.match(/conversation-task-item/g) || []).length, 3,
        'loose and nested task items receive controlled state markup');
    assert.match(looseTasks, /conversation-task-row[\s\S]*<ul>/,
        'nested task lists remain outside the horizontal task row');
    const multiParagraphTask = renderConversationMarkdown([
        '- [x] parent',
        '',
        '  continuation',
        '',
        '  - [ ] child',
    ].join('\n'));
    assert.match(multiParagraphTask, /conversation-task-label">parent<\/span><\/span>\s*<p>continuation<\/p>\s*<ul>/,
        'loose continuation paragraphs and nested lists remain outside the task row');
    assert.doesNotMatch(multiParagraphTask, /conversation-task-label">[^<]*<\/p>/,
        'a task label never consumes a paragraph closing tag');

    const prose = renderConversationMarkdown(
        'Costs $5 and $10 today. Use $HOME and $PATH in the shell. Escaped \\$x$ stays literal.'
    );
    assert.match(prose, /Costs \$5 and \$10 today\./);
    assert.match(prose, /Use \$HOME and \$PATH in the shell\./);
    assert.match(prose, /Escaped \$x\$ stays literal\./);

    const bounded = renderConversationMarkdown('$x$ '.repeat(300));
    assert.ok((bounded.match(/class="conversation-math(?: |")/g) || []).length <= 96,
        'one message never expands unboundedly through inline math');
    const invalidThenValid = renderConversationMarkdown(
        '$\\definitelyUnknownCommand$ '.repeat(96) + '$x$'
    );
    assert.doesNotMatch(invalidThenValid, /class="conversation-math(?: |")/,
        'failed KaTeX attempts consume the same per-message rendering budget');

    const started = performance.now();
    renderConversationMarkdown('a *b* '.repeat(9_000));
    assert.ok(performance.now() - started < 500,
        'plain Markdown text stays linear enough for a bounded live message');

    const adjacentCharts = renderConversationMarkdown([
        '```chart',
        '{"title":"Rendering coverage","labels":["Markdown","Math"],"values":[10,9]}',
        '```',
        '',
        '```pie-chart',
        '{"title":"Feature state","labels":["Ready","Preview"],"values":[8,1]}',
        '```',
    ].join('\n'));
    assert.equal((adjacentCharts.match(/conversation-chart-body/g) || []).length, 2,
        'every chart keeps its graphic and labels inside one card body');
});

test('CONVERSATION-RICH-MARKDOWN-006 renders controlled reference cards and explicit code line highlights', () => {
    const html = renderConversationMarkdown([
        '```typescript {2, 4-5}',
        'const one = 1;',
        'const two = 2;',
        'const three = 3;',
        'const four = 4;',
        'const five = 5;',
        '```',
        '',
        '```references',
        '[{"title":"Implementation","href":"src/aiSessions/conversation/markdown.ts:42","note":"Host-controlled renderer."},{"title":"Guide","href":"https://example.test/guide"}]',
        '```',
    ].join('\n'));

    assert.match(html, /conversation-code-numbered/);
    assert.match(html, /data-conversation-code-line="2"/);
    assert.match(html, /conversation-code-line-highlighted/);
    assert.match(html, /conversation-references/);
    assert.match(html, /href="src\/aiSessions\/conversation\/markdown\.ts:42"/);
    assert.match(html, /href="https:\/\/example\.test\/guide"/);
});

test('CONVERSATION-RICH-MARKDOWN-007 preserves aligned sortable Markdown tables', () => {
    const html = renderConversationMarkdown([
        '| Name | Score |',
        '| :--- | ---: |',
        '| Zebra | 2 |',
    ].join('\n'));

    assert.match(html, /conversation-table-sort/);
    assert.match(html, /conversation-table-align-left/);
    assert.match(html, /conversation-table-align-right/);
    assert.match(html, /data-conversation-sort-column="1"/);
});

test('CONVERSATION-RICH-MARKDOWN-009 keeps linked table headers independently interactive', () => {
    const html = renderConversationMarkdown([
        '| [Docs](https://example.test/docs) | Score |',
        '| --- | ---: |',
        '| Alpha | 1 |',
    ].join('\n'));

    assert.match(html, /<span class="conversation-table-heading"><a href="https:\/\/example\.test\/docs">Docs<\/a><\/span><button/);
    assert.doesNotMatch(html, /<button[^>]*>[\s\S]*<a href=/,
        'a sortable header never nests a link inside its button');
    assert.match(html, /conversation-table-sort-label">Sort by Docs<\/span>/);
});

test('CONVERSATION-DIFF-VISIBILITY-002 collapses only long unchanged diff context', () => {
    const context = Array.from({ length: 10 }, (_value, index) => ` line ${index + 1}`);
    const html = renderConversationMarkdown([
        '```diff',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,12 +1,12 @@',
        ...context,
        '-const oldValue = 1;',
        '+const newValue = 2;',
        '```',
    ].join('\n'));

    assert.match(html, /<details class="conversation-diff-context">/);
    assert.match(html, /… 4 unchanged lines/);
    assert.match(html, /conversation-diff-context-grid/);
    assert.match(html, /Changes only/);
});

test('CONVERSATION-LOCAL-FILE-LINKS-002 rejects traversal and unsafe workspace references', () => {
    const html = renderConversationMarkdown([
        '[traversal](../private.ts:1)',
        '[absolute](/tmp/private.ts:1)',
        '[unsafe](src/private.ts?token=secret:1)',
        'Do not link ../private.ts:1 or src/private.ts?token=secret:1.',
    ].join('\n\n'));

    assert.equal((html.match(/\shref=/g) || []).length, 1,
        'absolute links remain renderable but are Host-authorized');
    assert.match(html, /href="\/tmp\/private\.ts:1"/);
    assert.doesNotMatch(html, /href="\.\.\/private\.ts:1"/);
    assert.doesNotMatch(html, /href="src\/private\.ts\?token/);
});
