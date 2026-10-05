const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const script = require('../bot-pr-missing-linked-issue');
const { issue, createGithub, createCore } = require('./github-mock');

const MARKER = '<!-- pr-missing-linked-issue -->';
const BOT = { login: 'github-actions[bot]' };
const LINKED = `${MARKER}\nThis pull request is now linked to an issue. Thanks!`;

function prContext({ author = 'alice', headRepo = 'OSIPI/pyasl-studio' } = {}) {
  return {
    repo: { owner: 'OSIPI', repo: 'pyasl-studio' },
    payload: {
      pull_request: {
        number: 7,
        user: { login: author },
        head: { repo: headRepo === null ? null : { full_name: headRepo } },
      },
    },
  };
}

async function run(githubOptions, contextOptions) {
  const github = createGithub(githubOptions);
  const core = createCore();
  await script({ github, context: prContext(contextOptions), core });
  return { github, core };
}

beforeEach(() => {
  delete process.env.REQUIRE_AUTHOR_ASSIGNED;
});

test('passes without commenting when an assigned issue is linked', async () => {
  const { github, core } = await run({ linkedIssues: () => [issue(3, { assignees: ['alice'] })] });

  assert.equal(core.failed, null);
  assert.equal(github.calls.created.length, 0);
  assert.equal(github.calls.updated.length, 0);
});

test('fails and comments when no issue is linked', async () => {
  const { github, core } = await run({});

  assert.match(core.failed, /not linked to an open issue/);
  assert.equal(github.calls.created.length, 1);
  assert.ok(github.calls.created[0].body.startsWith(MARKER));
  assert.match(github.calls.created[0].body, /Fixes #123/);
  assert.match(github.calls.created[0].body, /closed automatically/);
});

test('fails and comments when the author is not assigned to the linked issue', async () => {
  const { github, core } = await run({ linkedIssues: () => [issue(3, { assignees: ['bob'] })] });

  assert.match(core.failed, /not assigned to the linked issue/);
  assert.match(github.calls.created[0].body, /ask a maintainer to assign the issue to you/);
  assert.match(github.calls.created[0].body, /closed automatically/);
});

test('queries the linked issues of this pull request', async () => {
  const { github } = await run({});

  assert.deepEqual(github.calls.graphql, [{ owner: 'OSIPI', repo: 'pyasl-studio', prNumber: 7 }]);
});

test('one assigned issue among several linked issues is enough', async () => {
  const { core } = await run({
    linkedIssues: () => [issue(3, { assignees: ['bob'] }), issue(4, { assignees: ['bob', 'alice'] })],
  });

  assert.equal(core.failed, null);
});

test('passes for an unassigned author when assignment is not required', async () => {
  process.env.REQUIRE_AUTHOR_ASSIGNED = 'false';

  const { core } = await run({ linkedIssues: () => [issue(3)] });

  assert.equal(core.failed, null);
});

test('a linked issue that is closed does not count', async () => {
  const { core } = await run({ linkedIssues: () => [issue(3, { state: 'CLOSED', assignees: ['alice'] })] });

  assert.match(core.failed, /not linked to an open issue/);
});

test('updates its earlier reminder once the pull request is fixed', async () => {
  const comments = [{ id: 11, user: BOT, body: `${MARKER}\nold reminder` }];

  const { github, core } = await run({ comments, linkedIssues: () => [issue(3, { assignees: ['alice'] })] });

  assert.equal(core.failed, null);
  assert.deepEqual(github.calls.updated.map((c) => [c.comment_id, c.body]), [[11, LINKED]]);
  assert.equal(github.calls.created.length, 0);
});

test('does not rewrite a comment that already says the right thing', async () => {
  const first = await run({});
  const comments = [{ id: 12, user: BOT, body: first.github.calls.created[0].body }];

  const { github, core } = await run({ comments });

  assert.ok(core.failed);
  assert.equal(github.calls.created.length, 0);
  assert.equal(github.calls.updated.length, 0);
});

test('switches its comment when the reason changes', async () => {
  const first = await run({});
  const comments = [{ id: 13, user: BOT, body: first.github.calls.created[0].body }];

  const { github } = await run({ comments, linkedIssues: () => [issue(3, { assignees: ['bob'] })] });

  assert.equal(github.calls.updated.length, 1);
  assert.match(github.calls.updated[0].body, /not assigned to that issue/);
});

test('ignores the marker in a comment written by someone else', async () => {
  const comments = [{ id: 14, user: { login: 'mallory' }, body: `${MARKER} not the bot` }];

  const { github } = await run({ comments });

  assert.equal(github.calls.updated.length, 0);
  assert.equal(github.calls.created.length, 1);
});

test('handles comments from deleted accounts or without a body', async () => {
  const comments = [{ id: 15, user: null, body: 'hi' }, { id: 16, user: BOT, body: null }];

  const { github } = await run({ comments });

  assert.equal(github.calls.created.length, 1);
});

test('pull requests from forks fail without any comment calls', async () => {
  const { github, core } = await run({}, { headRepo: 'someone/pyasl-studio' });

  assert.match(core.failed, /not linked to an open issue/);
  assert.equal(github.calls.listComments, 0);
  assert.equal(github.calls.created.length, 0);
});

test('valid pull requests from forks pass without any comment calls', async () => {
  const { github, core } = await run(
    { linkedIssues: () => [issue(3, { assignees: ['alice'] })] },
    { headRepo: 'someone/pyasl-studio' }
  );

  assert.equal(core.failed, null);
  assert.equal(github.calls.listComments, 0);
});

test('a fork that no longer exists is treated as a fork', async () => {
  const { github, core } = await run({}, { headRepo: null });

  assert.ok(core.failed);
  assert.equal(github.calls.listComments, 0);
});
