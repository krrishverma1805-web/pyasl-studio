// A script that closes pull requests without a linked issue after 24 hours automatically.

// dryRun env var: any case-insensitive 'true' value will enable dry-run
const dryRun = (process.env.DRY_RUN || 'false').toString().toLowerCase() === 'true';
const immediateCheck =
  (process.env.IMMEDIATE_CHECK || 'false').toLowerCase() === 'true';
const hoursBeforeClose = parseInt(process.env.HOURS_BEFORE_CLOSE || '24', 10);
const requireAuthorAssigned = (process.env.REQUIRE_AUTHOR_ASSIGNED || 'true').toLowerCase() === 'true';

const getHoursOpen = (pr) =>
  Math.floor((Date.now() - new Date(pr.created_at)) / (60 * 60 * 1000));

// Check if the PR author is a bot
const isBotAuthor = (pr) => pr.user?.type === 'Bot';

// Check if the PR author is assigned to the issue
const isAuthorAssigned = (issue, login) => {
  if (!issue || issue.state?.toUpperCase() !== 'OPEN') return false;
  const assignees = issue.assignees?.nodes?.map(a => a.login) || [];
  return assignees.includes(login);
};

const baseMessage = `Hi there!\nThis pull request has been automatically closed due to the following reason(s):
`;
const messageSuffix = `To link an issue, add a closing keyword such as \`Fixes #123\` to the pull request description.\n\nThank you!`;

const messages = {
  no_issue: `${baseMessage} - Reason: This pull request is not linked to any issue. Please link it to an issue and reopen the pull request if this is an error.\n${messageSuffix}`,
  not_assigned: `${baseMessage} - Reason: You are not assigned to the linked issue. Please ensure you are assigned before reopening the pull request.\n${messageSuffix}`
};

// Fetch linked issues using GraphQL
async function getLinkedIssues(github, pr, owner, repo) {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner:  $owner, name: $repo) {
        pullRequest(number:  $prNumber) {
          closingIssuesReferences(first: 100) {
            nodes {
              number
              state
              assignees(first: 100) {
                nodes { login }
              }
            }
          }
        }
      }
    }
  `;
  try {
    const result = await github.graphql(query, { owner, repo, prNumber: pr.number });
    const allIssues = result.repository.pullRequest.closingIssuesReferences.nodes || [];
    // Return only open issues
    return allIssues.filter(issue => issue.state === 'OPEN');
  } catch (err) {
    console.error(`GraphQL query failed for PR #${pr.number}:`, err.message);
    return null; // Signal error
  }
}

// Validation
async function validatePR(github, pr, owner, repo) {
  const issues = await getLinkedIssues(github, pr, owner, repo);

  // Skip on API errors (fail-safe)
  if (issues === null) {
    console.log(`Skipping PR #${pr.number} due to API error`);
    return { valid: true, apiError: true };
  }

  if (issues.length === 0) return { valid: false, reason: 'no_issue' };

  if (requireAuthorAssigned) {
    const assigned = issues.some(issue => isAuthorAssigned(issue, pr.user.login));
    if (!assigned) return { valid: false, reason: 'not_assigned' };
  }
  return { valid: true };
}

async function closePR(github, pr, owner, repo, reason) {
  if (dryRun) {
    console.log(`[DRY RUN] Would close PR #${pr.number} ${pr.html_url} (${reason})`);
    return true;
  }

  try {
    await github.rest.issues.createComment({
      owner, repo, issue_number: pr.number,
      body: messages[reason]
    });

    if (immediateCheck) {
      console.log(
        `✓ Commented on PR #${pr.number} (${reason}) link: ${pr.html_url}`
      );
      return true;
    }

    await github.rest.pulls.update({
      owner, repo, pull_number: pr.number, state: 'closed'
    });
    console.log(`✓ Closed PR #${pr.number} (${reason}) link: ${pr.html_url}`);
    return true;
  } catch (err) {
    console.error(`✗ Failed to close PR #${pr.number}:`, err.message);
    return false;
  }
}

module.exports = async ({ github, context, core }) => {
  if (Number.isNaN(hoursBeforeClose) || hoursBeforeClose < 0) {
    core.setFailed(`HOURS_BEFORE_CLOSE must be a number of hours (0 or more), got "${process.env.HOURS_BEFORE_CLOSE}".`);
    return;
  }

  let failures = 0;
  try {
    const { owner, repo } = context.repo;
    const prs = await github.paginate(github.rest.pulls.list, {
      owner, repo, state: 'open', per_page: 100
    });

    console.log(`Evaluating ${prs.length} open PRs\n`);

    for (const pr of prs) {

      const authorLogin = pr.user?.login;
      if (!authorLogin) {
        console.warn(`PR #${pr.number} missing author login. Skipping for safety.`);
        continue;
      }
      if (isBotAuthor(pr)) {
        console.log(`PR #${pr.number} authored by bot (${authorLogin}). Skipping.`);
        continue;
      }

      const hours = getHoursOpen(pr);
      if (!immediateCheck && hours < hoursBeforeClose) {
        console.log(
          `PR #${pr.number} link: ${pr.html_url} is only ${hours} hours old. Skipping.`
        );
        continue;
      }

      const { valid, reason, apiError } = await validatePR(github, pr, owner, repo);
      if (apiError) {
        failures++;
      } else if (valid) {
        console.log(`PR #${pr.number} link: ${pr.html_url} is Valid ✓.`);
      } else if (!(await closePR(github, pr, owner, repo, reason))) {
        failures++;
      }
    }
  } catch (err) {
    console.error('Unexpected error:', err.message);
    failures++;
  }

  if (failures > 0) {
    core.setFailed(`${failures} problem(s) while checking or closing pull requests. See the log above.`);
  }
};
