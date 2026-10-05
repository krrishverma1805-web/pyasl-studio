const MARKER = '<!-- pr-missing-linked-issue -->';

const COMMENTS = {
  no_issue: [
    'This pull request is not linked to an open issue.',
    '',
    'Please add a closing keyword followed by the issue number to the description, for example:',
    '',
    '```',
    'Fixes #123',
    '```',
    '',
    'If there is no issue for this change yet, please open one first. If this pull request stays unlinked, it will be closed automatically.',
  ].join('\n'),
  not_assigned: [
    'This pull request is linked to an issue, but its author is not assigned to that issue.',
    '',
    'Please ask a maintainer to assign the issue to you. Assigning an issue does not re-run this check, so after that, edit the description or push a commit to run it again. If this pull request stays like this, it will be closed automatically.',
  ].join('\n'),
};

const CHECK_MESSAGES = {
  no_issue: 'This pull request is not linked to an open issue. Add "Fixes #<issue number>" to the description to link one.',
  not_assigned: 'The author of this pull request is not assigned to the linked issue. Ask a maintainer to assign it.',
};

async function getOpenLinkedIssues(github, owner, repo, prNumber) {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          closingIssuesReferences(first: 100) {
            nodes {
              number
              state
              assignees(first: 100) {
                nodes {
                  login
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await github.graphql(query, { owner, repo, prNumber });
  return result.repository.pullRequest.closingIssuesReferences.nodes.filter((issue) => issue.state === 'OPEN');
}

// Returns why a pull request fails the linked issue rule, or null if it passes.
function findLinkedIssueProblem(issues, author, requireAuthorAssigned) {
  if (issues.length === 0) {
    return 'no_issue';
  }
  const isAssigned = (issue) => issue.assignees.nodes.some((assignee) => assignee.login === author);
  if (requireAuthorAssigned && !issues.some(isAssigned)) {
    return 'not_assigned';
  }
  return null;
}

module.exports = async ({ github, context, core }) => {
  const requireAuthorAssigned = (process.env.REQUIRE_AUTHOR_ASSIGNED || 'true').toLowerCase() === 'true';
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;

  // Pull requests from forks only get a read-only token, so the bot can't comment on them.
  const canComment = pr.head.repo?.full_name === `${owner}/${repo}`;

  const issues = await getOpenLinkedIssues(github, owner, repo, pr.number);
  const problem = findLinkedIssueProblem(issues, pr.user.login, requireAuthorAssigned);

  let previous;
  if (canComment) {
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
    });
    previous = comments.find(
      (comment) => comment.user?.login === 'github-actions[bot]' && comment.body?.includes(MARKER)
    );
  }

  const postComment = async (body) => {
    if (!previous) {
      await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
    } else if (previous.body !== body) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: previous.id, body });
    }
  };

  if (!problem) {
    core.info(`Linked issue(s): ${issues.map((issue) => `#${issue.number}`).join(', ')}`);
    if (previous) {
      await postComment(`${MARKER}\nThis pull request is now linked to an issue. Thanks!`);
    }
    return;
  }

  if (canComment) {
    await postComment(`${MARKER}\n${COMMENTS[problem]}`);
  }
  core.setFailed(CHECK_MESSAGES[problem]);
};
