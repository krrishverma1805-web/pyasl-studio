const MARKER = '<!-- pr-missing-linked-issue -->';

async function getLinkedIssues(github, owner, repo, prNumber) {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          closingIssuesReferences(first: 10) {
            nodes {
              number
            }
          }
        }
      }
    }
  `;

  const result = await github.graphql(query, { owner, repo, prNumber });
  return result.repository.pullRequest.closingIssuesReferences.nodes;
}

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;

  // Pull requests from forks only get a read-only token, so the bot can't comment on them.
  const canComment = pr.head.repo?.full_name === `${owner}/${repo}`;

  const linkedIssues = await getLinkedIssues(github, owner, repo, pr.number);

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

  if (linkedIssues.length > 0) {
    core.info(`Linked issue(s): ${linkedIssues.map((issue) => `#${issue.number}`).join(', ')}`);
    if (previous) {
      await postComment(`${MARKER}\nThis pull request is now linked to an issue. Thanks!`);
    }
    return;
  }

  if (canComment) {
    await postComment(
      [
        MARKER,
        'This pull request is not linked to an issue.',
        '',
        'Please add a closing keyword followed by the issue number to the description, for example:',
        '',
        '```',
        'Fixes #123',
        '```',
        '',
        'If there is no issue for this change yet, please open one first.',
      ].join('\n')
    );
  }

  core.setFailed(
    'This pull request is not linked to an issue. Add "Fixes #<issue number>" to the description to link one.'
  );
};
