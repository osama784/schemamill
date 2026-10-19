// Closes the issues linked from a pull request's body when that pull request merges into `dev`.
//
// GitHub's native closing-keyword auto-close only fires for merges into the repository's default
// branch (`main`), so `dev` merges need this script. The workflow imports it from the checked-out
// workspace (`actions/github-script`), so keep it dependency-free and Node 24-compatible ESM.

// The full GitHub closing-keyword set: `close[sd]`, `fix(es|ed)`, `resolve[sd]`, case-insensitive,
// with an optional colon before the reference. Comma lists (`Closes #1, #2`) are deliberately not
// expanded: only the reference immediately after a keyword counts, so a bare `#2` is never closed
// by association.
const CLOSING_KEYWORD_PATTERN = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?):?\s*#(\d+)\b/gi;

/**
 * Collects the issue numbers a PR body links with a closing keyword.
 * @param {unknown} text
 * @returns {number[]} sorted, deduped, positive issue numbers
 */
export function parseClosingIssueNumbers(text) {
  if (typeof text !== 'string') return [];

  const numbers = [];
  for (const match of text.matchAll(CLOSING_KEYWORD_PATTERN)) {
    const number = Number(match[1]);
    // `#0` is never a real issue; `#-N` cannot match the pattern at all.
    if (number >= 1) numbers.push(number);
  }
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/**
 * Whether a `pull_request` event payload is a merge into `dev`.
 * @param {unknown} payload
 * @returns {boolean}
 */
export function shouldClose(payload) {
  return payload?.pull_request?.merged === true && payload?.pull_request?.base?.ref === 'dev';
}

/**
 * Closes every issue the merged pull request links, reporting each outcome through `core`.
 * @param {{ github: object, context: object, core: object }} args
 * @returns {Promise<{ requested: number[], closed: number[], skipped: number[], failed: number[] }>}
 */
export async function closeIssues({ github, context, core }) {
  const summary = { requested: [], closed: [], skipped: [], failed: [] };

  if (!shouldClose(context.payload)) {
    core.notice('Not a merge into dev; nothing to close.');
    return summary;
  }

  const pullRequest = context.payload.pull_request;
  summary.requested = parseClosingIssueNumbers(pullRequest.body ?? '');

  if (summary.requested.length === 0) {
    core.notice(`PR #${pullRequest.number} links no issues with a closing keyword.`);
    return summary;
  }

  for (const number of summary.requested) {
    try {
      const { data: issue } = await github.rest.issues.get({
        ...context.repo,
        issue_number: number,
      });

      if (issue.state === 'closed') {
        summary.skipped.push(number);
        core.notice(`Issue #${number} is already closed; skipping.`);
        continue;
      }

      // A closing keyword pointing at a pull request is a mistake worth surfacing, not closing.
      if (issue.pull_request !== undefined) {
        summary.failed.push(number);
        core.warning(`#${number} is a pull request, not an issue; refusing to close it.`);
        continue;
      }

      await github.rest.issues.update({ ...context.repo, issue_number: number, state: 'closed' });
      summary.closed.push(number);
      core.notice(`Closed issue #${number}, linked from PR #${pullRequest.number}.`);
    } catch (error) {
      summary.failed.push(number);
      core.warning(`Failed to close issue #${number}: ${error.message}`);
    }
  }

  if (summary.failed.length > 0) {
    const list = summary.failed.map((failed) => `#${failed}`).join(', ');
    core.setFailed(`Failed to close ${summary.failed.length} linked issue(s): ${list}`);
  }

  return summary;
}
