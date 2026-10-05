// In-memory stand-ins for the github and core objects that actions/github-script provides.

function issue(number, { state = 'OPEN', assignees = [] } = {}) {
  return { number, state, assignees: { nodes: assignees.map((login) => ({ login })) } };
}

function createGithub({
  linkedIssues = () => [],
  comments = [],
  openPulls = [],
  defaultBranch = 'main',
  failComment = [],
  failClose = [],
} = {}) {
  const calls = { graphql: [], repoGets: 0, pullLists: [], listComments: 0, created: [], updated: [], closed: [] };

  return {
    calls,
    graphql: async (query, variables) => {
      calls.graphql.push(variables);
      return { repository: { pullRequest: { closingIssuesReferences: { nodes: linkedIssues(variables.prNumber) } } } };
    },
    paginate: async (method, params) => method(params),
    rest: {
      repos: {
        get: async () => {
          calls.repoGets++;
          return { data: { default_branch: defaultBranch } };
        },
      },
      pulls: {
        list: (params) => {
          calls.pullLists.push(params);
          return openPulls;
        },
        update: async (params) => {
          if (failClose.includes(params.pull_number)) {
            throw new Error('close failed');
          }
          calls.closed.push(params.pull_number);
        },
      },
      issues: {
        listComments: () => {
          calls.listComments++;
          return comments;
        },
        createComment: async (params) => {
          if (failComment.includes(params.issue_number)) {
            throw new Error('comment failed');
          }
          calls.created.push(params);
        },
        updateComment: async (params) => {
          calls.updated.push(params);
        },
      },
    },
  };
}

function createCore() {
  const core = { infos: [], warnings: [], failed: null };
  core.info = (message) => core.infos.push(message);
  core.warning = (message) => core.warnings.push(message);
  core.setFailed = (message) => {
    core.failed = message;
  };
  return core;
}

module.exports = { issue, createGithub, createCore };
