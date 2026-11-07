import assert from 'node:assert/strict';
import { test } from 'node:test';

import { closeIssues, parseClosingIssueNumbers, shouldClose } from './closes.mjs';

function fakeCore() {
  return {
    notices: [],
    warnings: [],
    failures: [],
    notice(message) {
      this.notices.push(message);
    },
    warning(message) {
      this.warnings.push(message);
    },
    setFailed(message) {
      this.failures.push(message);
    },
  };
}

// A fake `github` whose two endpoints record every call. A handler decides the response; a
// missing handler throws, so an endpoint the test does not expect fails loudly if it is called.
function fakeGithub(handlers = {}) {
  const calls = { get: [], update: [] };
  const respond = (kind) => (params) => {
    calls[kind].push(params);
    if (!handlers[kind]) throw new Error(`unexpected issues.${kind} call`);
    return handlers[kind](params);
  };
  return {
    calls,
    rest: {
      issues: {
        get: respond('get'),
        update: respond('update'),
      },
    },
  };
}

function mergedContext({ body = '', number = 78 } = {}) {
  return {
    repo: { owner: 'osama784', repo: 'schemamill' },
    payload: { pull_request: { number, merged: true, base: { ref: 'dev' }, body } },
  };
}

function openIssue(number) {
  return { data: { number, state: 'open' } };
}

test('parseClosingIssueNumbers reads each keyword form', () => {
  assert.deepEqual(parseClosingIssueNumbers('Closes #78.'), [78]);
  assert.deepEqual(parseClosingIssueNumbers('- Closes #74'), [74]);
  assert.deepEqual(parseClosingIssueNumbers('Fixes #1'), [1]);
  assert.deepEqual(parseClosingIssueNumbers('Fixed #1'), [1]);
  assert.deepEqual(parseClosingIssueNumbers('fix #1'), [1]);
  assert.deepEqual(parseClosingIssueNumbers('Resolved: #2'), [2]);
  assert.deepEqual(parseClosingIssueNumbers('Resolves #3'), [3]);
  assert.deepEqual(parseClosingIssueNumbers('close #4'), [4]);
  assert.deepEqual(parseClosingIssueNumbers('Resolved #5'), [5]);
});

test('parseClosingIssueNumbers finds every reference in prose', () => {
  assert.deepEqual(parseClosingIssueNumbers('closes #5, closes #6'), [5, 6]);
  assert.deepEqual(parseClosingIssueNumbers('Fixes #9, and closes #3.'), [3, 9]);
});

test('parseClosingIssueNumbers dedupes and sorts', () => {
  assert.deepEqual(parseClosingIssueNumbers('Fixes #9\nCloses #3\nfixes #9'), [3, 9]);
});

test('parseClosingIssueNumbers does not expand comma lists', () => {
  assert.deepEqual(parseClosingIssueNumbers('Closes #5, #6'), [5]);
});

test('parseClosingIssueNumbers ignores text without keywords', () => {
  assert.deepEqual(parseClosingIssueNumbers(''), []);
  assert.deepEqual(parseClosingIssueNumbers('Refs #7 and nothing else'), []);
  assert.deepEqual(parseClosingIssueNumbers('The prefix closes nothing'), []);
});

test('parseClosingIssueNumbers rejects non-string input', () => {
  assert.deepEqual(parseClosingIssueNumbers(null), []);
  assert.deepEqual(parseClosingIssueNumbers(undefined), []);
  assert.deepEqual(parseClosingIssueNumbers(42), []);
  assert.deepEqual(parseClosingIssueNumbers({ body: 'Closes #1' }), []);
});

test('parseClosingIssueNumbers ignores #0 and negative references', () => {
  assert.deepEqual(parseClosingIssueNumbers('Closes #0'), []);
  assert.deepEqual(parseClosingIssueNumbers('Closes #-1'), []);
});

test('shouldClose accepts only merges into dev', () => {
  assert.equal(shouldClose({ pull_request: { merged: true, base: { ref: 'dev' } } }), true);
  assert.equal(shouldClose({ pull_request: { merged: false, base: { ref: 'dev' } } }), false);
  assert.equal(shouldClose({ pull_request: { merged: true, base: { ref: 'main' } } }), false);
  assert.equal(shouldClose({ pull_request: { base: { ref: 'dev' } } }), false);
  assert.equal(shouldClose({}), false);
  assert.equal(shouldClose(undefined), false);
});

test('closeIssues closes an open linked issue', async () => {
  const core = fakeCore();
  const github = fakeGithub({
    get: () => openIssue(78),
    update: () => ({ data: { number: 78, state: 'closed' } }),
  });
  const context = mergedContext({ body: 'Closes #78' });

  const summary = await closeIssues({ github, context, core });

  assert.deepEqual(summary, { requested: [78], closed: [78], skipped: [], failed: [] });
  assert.deepEqual(github.calls.get, [{ owner: 'osama784', repo: 'schemamill', issue_number: 78 }]);
  assert.deepEqual(github.calls.update, [
    { owner: 'osama784', repo: 'schemamill', issue_number: 78, state: 'closed' },
  ]);
  assert.equal(core.notices.length, 1);
  assert.match(core.notices[0], /#78/);
  assert.deepEqual(core.warnings, []);
  assert.deepEqual(core.failures, []);
});

test('closeIssues skips an already-closed issue without failing', async () => {
  const core = fakeCore();
  const github = fakeGithub({ get: () => ({ data: { number: 78, state: 'closed' } }) });

  const summary = await closeIssues({
    github,
    context: mergedContext({ body: 'Closes #78' }),
    core,
  });

  assert.deepEqual(summary, { requested: [78], closed: [], skipped: [78], failed: [] });
  assert.deepEqual(github.calls.update, []);
  assert.equal(core.notices.length, 1);
  assert.match(core.notices[0], /already closed/);
  assert.deepEqual(core.failures, []);
});

test('closeIssues fails loudly when the issue lookup fails', async () => {
  const core = fakeCore();
  const github = fakeGithub({
    get: () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  });

  const summary = await closeIssues({
    github,
    context: mergedContext({ body: 'Closes #404' }),
    core,
  });

  assert.deepEqual(summary, { requested: [404], closed: [], skipped: [], failed: [404] });
  assert.deepEqual(github.calls.update, []);
  assert.equal(core.warnings.length, 1);
  assert.match(core.warnings[0], /#404/);
  assert.match(core.warnings[0], /Not Found/);
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /#404/);
});

test('closeIssues fails loudly when the close call fails', async () => {
  const core = fakeCore();
  const github = fakeGithub({
    get: () => openIssue(78),
    update: () => {
      throw new Error('Validation Failed');
    },
  });

  const summary = await closeIssues({
    github,
    context: mergedContext({ body: 'Closes #78' }),
    core,
  });

  assert.deepEqual(summary, { requested: [78], closed: [], skipped: [], failed: [78] });
  assert.deepEqual(github.calls.update, [
    { owner: 'osama784', repo: 'schemamill', issue_number: 78, state: 'closed' },
  ]);
  assert.equal(core.warnings.length, 1);
  assert.match(core.warnings[0], /#78/);
  assert.match(core.warnings[0], /Validation Failed/);
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /#78/);
});

test('closeIssues reports the closed, skipped, and failed subsets of a batch', async () => {
  const core = fakeCore();
  const github = fakeGithub({
    get: (params) => {
      if (params.issue_number === 4) throw new Error('Not Found');
      return {
        data: { number: params.issue_number, state: params.issue_number === 2 ? 'closed' : 'open' },
      };
    },
    update: (params) => ({ data: { number: params.issue_number, state: 'closed' } }),
  });

  const summary = await closeIssues({
    github,
    context: mergedContext({ body: 'Closes #1\nFixes #2\nResolves #3\nclose #4' }),
    core,
  });

  assert.deepEqual(summary, { requested: [1, 2, 3, 4], closed: [1, 3], skipped: [2], failed: [4] });
  assert.deepEqual(
    github.calls.update.map((params) => params.issue_number),
    [1, 3],
  );
  assert.equal(core.notices.length, 3);
  assert.equal(core.warnings.length, 1);
  assert.match(core.warnings[0], /#4/);
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /#4/);
});

test('closeIssues refuses to close a reference to a pull request', async () => {
  const core = fakeCore();
  const github = fakeGithub({
    get: () => ({
      data: { number: 78, state: 'open', pull_request: { url: 'https://example.test/pulls/78' } },
    }),
  });

  const summary = await closeIssues({
    github,
    context: mergedContext({ body: 'Closes #78' }),
    core,
  });

  assert.deepEqual(summary, { requested: [78], closed: [], skipped: [], failed: [78] });
  assert.deepEqual(github.calls.update, []);
  assert.equal(core.warnings.length, 1);
  assert.match(core.warnings[0], /pull request/);
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /#78/);
});

test('closeIssues notices and stops when the PR links no issues', async () => {
  const core = fakeCore();
  const github = fakeGithub();

  const summary = await closeIssues({
    github,
    context: mergedContext({ body: 'No references here.' }),
    core,
  });

  assert.deepEqual(summary, { requested: [], closed: [], skipped: [], failed: [] });
  assert.deepEqual(github.calls.get, []);
  assert.deepEqual(github.calls.update, []);
  assert.equal(core.notices.length, 1);
  assert.match(core.notices[0], /#78/);
  assert.deepEqual(core.failures, []);
});

test('closeIssues does nothing when the PR is not merged', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  const context = mergedContext({ body: 'Closes #78' });
  context.payload.pull_request.merged = false;

  const summary = await closeIssues({ github, context, core });

  assert.deepEqual(summary, { requested: [], closed: [], skipped: [], failed: [] });
  assert.deepEqual(github.calls.get, []);
  assert.deepEqual(github.calls.update, []);
  assert.equal(core.notices.length, 1);
  assert.deepEqual(core.failures, []);
});

test('closeIssues does nothing when the merge target is not dev', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  const context = mergedContext({ body: 'Closes #78' });
  context.payload.pull_request.base.ref = 'main';

  const summary = await closeIssues({ github, context, core });

  assert.deepEqual(summary, { requested: [], closed: [], skipped: [], failed: [] });
  assert.deepEqual(github.calls.get, []);
  assert.deepEqual(github.calls.update, []);
  assert.equal(core.notices.length, 1);
  assert.deepEqual(core.failures, []);
});
