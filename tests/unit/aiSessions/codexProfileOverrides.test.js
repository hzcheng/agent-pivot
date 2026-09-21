'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    CodexProfileOverrideError,
    flattenCodexProfileToml,
} = require('../../../out/aiSessions/codexProfileOverrides');

test('SESSION-CODEX-PROFILE-LAUNCH-001 flattens a profile-v2 file into verbatim -c overrides', () => {
    const source = [
        '# a comment',
        'model_provider = "codewiz"',
        'model = "codewiz:kimi3" # trailing comment',
        'model_context_window = 1000000',
        'model_reasoning_effort = "high"',
        '',
        '[model_providers.codewiz]',
        'name = "codewiz"',
        'wire_api = "responses"',
        'requires_openai_auth = false',
        'base_url = "http://127.0.0.1:18089"',
        '',
        '[agents]',
        'default_subagent_model = "codewiz:kimi3"',
    ].join('\n');
    assert.deepEqual(flattenCodexProfileToml(source), [
        'model_provider="codewiz"',
        'model="codewiz:kimi3"',
        'model_context_window=1000000',
        'model_reasoning_effort="high"',
        'model_providers.codewiz.name="codewiz"',
        'model_providers.codewiz.wire_api="responses"',
        'model_providers.codewiz.requires_openai_auth=false',
        'model_providers.codewiz.base_url="http://127.0.0.1:18089"',
        'agents.default_subagent_model="codewiz:kimi3"',
    ]);
});

test('SESSION-CODEX-PROFILE-LAUNCH-001 keeps multiline arrays and inline tables verbatim', () => {
    const source = [
        'sandbox_workspace_write.writable_roots = [',
        '  "/a", # comment inside an array',
        '  "/b",',
        ']',
        'notice = { hide_full_access_warning = true }',
        'windows_sandbox = { elevated = { enabled = false } }',
    ].join('\n');
    assert.deepEqual(flattenCodexProfileToml(source), [
        'sandbox_workspace_write.writable_roots=[\n  "/a", # comment inside an array\n  "/b",\n]',
        'notice={ hide_full_access_warning = true }',
        'windows_sandbox={ elevated = { enabled = false } }',
    ]);
});

test('SESSION-CODEX-PROFILE-LAUNCH-001 handles dotted, escaped, literal, and multiline strings', () => {
    const source = [
        'model = "a \\"quoted\\" model"',
        "literal = 'C:\\\\path'",
        'instructions = """',
        'line one',
        'line two',
        '"""',
        'web_search = "live"',
    ].join('\n');
    const entries = flattenCodexProfileToml(source);
    assert.equal(entries[0], 'model="a \\"quoted\\" model"');
    assert.equal(entries[1], "literal='C:\\\\path'");
    assert.equal(entries[2], 'instructions="""\nline one\nline two\n"""');
    assert.equal(entries[3], 'web_search="live"');
});

test('SESSION-CODEX-PROFILE-LAUNCH-001 rejects arrays of tables, non-bare root keys, and malformed input', () => {
    assert.throws(
        () => flattenCodexProfileToml('[[projects.alpha]]\npath = "/a"\n'),
        CodexProfileOverrideError
    );
    assert.throws(
        () => flattenCodexProfileToml('["quoted.key"]\nx = 1\n'),
        CodexProfileOverrideError
    );
    assert.throws(
        () => flattenCodexProfileToml('model = "unterminated\n'),
        CodexProfileOverrideError
    );
    assert.throws(
        () => flattenCodexProfileToml('model "missing equals"\n'),
        CodexProfileOverrideError
    );
    assert.throws(
        () => flattenCodexProfileToml('roots = ["/a"\n'),
        CodexProfileOverrideError
    );
});


test('SESSION-CODEX-PROFILE-LAUNCH-001 preserves quoted project paths and sibling trust settings', () => {
    const source = [
        'model = "kimi-code:k3"',
        '[projects."/home/hzcheng/projects/repos/deer-flow"]',
        'trust_level = "trusted"',
        '[projects."/tmp/repo.with.dots"]',
        'trust_level = "untrusted"',
        '[projects.plain]',
        'trust_level = "trusted"',
    ].join('\n');
    const entries = flattenCodexProfileToml(source);
    assert.equal(entries[0], 'model="kimi-code:k3"');
    assert.equal(entries.length, 2, 'one parent override must preserve all siblings');
    assert.equal(entries[1], 'projects={"/home/hzcheng/projects/repos/deer-flow"={trust_level="trusted"},"/tmp/repo.with.dots"={trust_level="untrusted"},plain={trust_level="trusted"}}');
});

test('SESSION-CODEX-PROFILE-LAUNCH-001 decodes literal, escaped and Unicode keys without splitting dots', () => {
    const entries = flattenCodexProfileToml(String.raw`
[projects.'/tmp/literal.repo']
trust_level = "trusted"
[projects."/tmp/quoted\"repo"]
trust_level = "untrusted"
[projects."/tmp/\U0001F600"]
trust_level = "trusted"
[projects."/tmp/\\U0001F600"]
trust_level = "untrusted"
`);
    assert.deepEqual(entries, ['projects={"/tmp/literal.repo"={trust_level="trusted"},"/tmp/quoted\\"repo"={trust_level="untrusted"},"/tmp/😀"={trust_level="trusted"},"/tmp/\\\\U0001F600"={trust_level="untrusted"}}']);
});

test('SESSION-CODEX-PROFILE-LAUNCH-001 rejects conflicting grouped keys and invalid quoted keys', () => {
    for (const source of [
        '[projects."/tmp/a"]\nx=1\nx=2',
        '[projects."/tmp/a"]\nx=1\nx.y=2',
        '[projects."/tmp/a"]\nx.y=2\nx=1',
        '[projects."""/tmp/a"""]\nx=1',
        String.raw`[projects."\U00110000"]` + '\nx=1',
        String.raw`[projects."\U0000D800"]` + '\nx=1',
        String.raw`[projects."\q"]` + '\nx=1',
    ]) assert.throws(() => flattenCodexProfileToml(source), CodexProfileOverrideError);
});

test('SESSION-CODEX-PROFILE-LAUNCH-001 retains TOML escaping for DEL and empty nested keys', () => {
    assert.deepEqual(flattenCodexProfileToml(String.raw`[projects."/tmp/\u007f"]` + '\nx=1\n[projects.""]\nx=2'),
        [String.raw`projects={"/tmp/\u007f"={x=1},""={x=2}}`]);
});
