const { test } = require('node:test');
const assert = require('node:assert/strict');

const { issue, createGithub, createCore } = require('./github-mock');

const HOUR = 60 * 60 * 1000;
const SETTINGS = ['DRY_RUN', 'HOURS_BEFORE_CLOSE', 'REQUIRE_AUTHOR_ASSIGNED', 'IMMEDIATE_CHECK'];
const context = { repo: { owner: 'OSIPI', repo: 'pyasl-studio' } };

function pull(number, { author = 'alice', type = 'User', draft = false, hoursOld = 48 } = {}) {
  return {
    number,
    draft,
    html_url: `https://github.com/OSIPI/pyasl-studio/pull/${number}`,
    user: author === null ? null : { login: author, type },
    created_at: new Date(Date.now() - hoursOld * HOUR).toISOString(),
  };
}

const assigned = (login = 'alice') => [issue(3, { assignees: [login] })];

// The script reads its settings when it is loaded, so load a fresh copy for each run.
async function run(t, settings, githubOptions) {
  for (const name of SETTINGS) {
    delete process.env[name];
  }
  Object.assign(process.env, settings);
  delete require.cache[require.resolve('../cron-enforcer-pr-linked-issue')];
  const script = require('../cron-enforcer-pr-linked-issue');

  const logs = [];
  for (const method of ['log', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => logs.push(args.join(' ')));
  }

  const github = createGithub(githubOptions);
  const core = createCore();
  await script({ github, context, core });
  return { github, core, logs };
}

test('closes an old pull request with no linked issue, commenting first', async (t) => {
  const { github, core } = await run(t, {}, { openPulls: [pull(1)] });

  assert.deepEqual(github.calls.closed, [1]);
  assert.equal(github.calls.created.length, 1);
  assert.match(github.calls.created[0].body, /not linked to any issue/);
  assert.match(github.calls.created[0].body, /Fixes #123/);
  assert.equal(core.failed, null);
});

test('closes a pull request whose author is not assigned to the linked issue', async (t) => {
  const { github } = await run(t, {}, { openPulls: [pull(1)], linkedIssues: () => assigned('bob') });

  assert.deepEqual(github.calls.closed, [1]);
  assert.match(github.calls.created[0].body, /not assigned to the linked issue/);
});

test('leaves a pull request with an assigned linked issue open', async (t) => {
  const { github } = await run(t, {}, { openPulls: [pull(1)], linkedIssues: () => assigned() });

  assert.deepEqual(github.calls.closed, []);
  assert.equal(github.calls.created.length, 0);
});

test('treats a pull request linked only to closed issues as unlinked', async (t) => {
  const { github } = await run(t, {}, {
    openPulls: [pull(1)],
    linkedIssues: () => [issue(3, { state: 'CLOSED', assignees: ['alice'] })],
  });

  assert.deepEqual(github.calls.closed, [1]);
  assert.match(github.calls.created[0].body, /not linked to any issue/);
});

test('does not require assignment when it is switched off', async (t) => {
  const { github } = await run(t, { REQUIRE_AUTHOR_ASSIGNED: 'false' }, {
    openPulls: [pull(1)],
    linkedIssues: () => assigned('bob'),
  });

  assert.deepEqual(github.calls.closed, []);
});

test('skips pull requests opened by bots or without an author', async (t) => {
  const { github } = await run(t, {}, {
    openPulls: [pull(1, { type: 'Bot', author: 'dependabot[bot]' }), pull(2, { author: null })],
  });

  assert.deepEqual(github.calls.graphql, []);
  assert.deepEqual(github.calls.closed, []);
});

test('closes draft pull requests too', async (t) => {
  const { github } = await run(t, {}, { openPulls: [pull(1, { draft: true })] });

  assert.deepEqual(github.calls.closed, [1]);
});

test('respects the default 24 hour grace period', async (t) => {
  const { github } = await run(t, {}, { openPulls: [pull(1, { hoursOld: 23 }), pull(2, { hoursOld: 25 })] });

  assert.deepEqual(github.calls.closed, [2]);
});

test('a grace period of 0 hours acts on new pull requests', async (t) => {
  const { github } = await run(t, { HOURS_BEFORE_CLOSE: '0' }, { openPulls: [pull(1, { hoursOld: 0 })] });

  assert.deepEqual(github.calls.closed, [1]);
});

test('stops before touching any pull request when the grace period is not a valid number', async (t) => {
  for (const value of ['abc', '-1']) {
    const { github, core } = await run(t, { HOURS_BEFORE_CLOSE: value }, { openPulls: [pull(1)] });

    assert.match(core.failed, /HOURS_BEFORE_CLOSE must be a number of hours/);
    assert.deepEqual(github.calls.pullLists, []);
    assert.deepEqual(github.calls.closed, []);
  }
});

test('a dry run only logs what it would close', async (t) => {
  const { github, logs } = await run(t, { DRY_RUN: 'TRUE' }, { openPulls: [pull(1)] });

  assert.deepEqual(github.calls.closed, []);
  assert.equal(github.calls.created.length, 0);
  assert.ok(logs.some((line) => line.includes('[DRY RUN] Would close PR #1')));
});

test('with IMMEDIATE_CHECK it comments without closing, whatever the age', async (t) => {
  const { github } = await run(t, { IMMEDIATE_CHECK: 'true' }, { openPulls: [pull(1, { hoursOld: 0 })] });

  assert.equal(github.calls.created.length, 1);
  assert.deepEqual(github.calls.closed, []);
});

test('lists every open pull request through pagination', async (t) => {
  const { github } = await run(t, {}, { openPulls: [] });

  assert.deepEqual(github.calls.pullLists, [{ owner: 'OSIPI', repo: 'pyasl-studio', state: 'open', per_page: 100 }]);
});

test('an API error leaves that pull request open, the run continues and is marked failed', async (t) => {
  const { github, core } = await run(t, {}, {
    openPulls: [pull(1), pull(2)],
    linkedIssues: (prNumber) => {
      if (prNumber === 1) {
        throw new Error('GraphQL unavailable');
      }
      return [];
    },
  });

  assert.deepEqual(github.calls.closed, [2]);
  assert.match(core.failed, /1 problem\(s\) while checking or closing/);
});

test('a failed comment means the pull request is not closed and the run is marked failed', async (t) => {
  const { github, core } = await run(t, {}, { openPulls: [pull(1), pull(2)], failComment: [1] });

  assert.deepEqual(github.calls.closed, [2]);
  assert.match(core.failed, /1 problem\(s\)/);
});

test('a failed close is counted and the run continues', async (t) => {
  const { github, core } = await run(t, {}, { openPulls: [pull(1), pull(2)], failClose: [1] });

  assert.deepEqual(github.calls.closed, [2]);
  assert.match(core.failed, /1 problem\(s\)/);
});

test('closes exactly the pull requests that the per-pull-request check fails', async (t) => {
  const checkScript = require('../bot-pr-missing-linked-issue');
  const situations = [
    [],
    [issue(3, { assignees: ['alice'] })],
    [issue(3, { assignees: ['bob'] })],
    [issue(3, { state: 'CLOSED', assignees: ['alice'] })],
    [issue(3, { assignees: ['bob'] }), issue(4, { assignees: ['alice'] })],
  ];

  for (const linked of situations) {
    const { github } = await run(t, {}, { openPulls: [pull(1)], linkedIssues: () => linked });
    const check = createCore();
    await checkScript({
      github: createGithub({ linkedIssues: () => linked }),
      context: { ...context, payload: { pull_request: { number: 1, user: { login: 'alice' }, head: { repo: null } } } },
      core: check,
    });

    assert.equal(github.calls.closed.length === 1, check.failed !== null);
  }
});

test('a run with nothing to close succeeds', async (t) => {
  const { core } = await run(t, {}, { openPulls: [pull(1)], linkedIssues: () => assigned() });

  assert.equal(core.failed, null);
});
