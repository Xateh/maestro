function trackerError(code, message = code, cause = null) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  inverseRelations {
    nodes {
      type
      relatedIssue {
        id
        identifier
        state { name }
      }
    }
  }
`;

const CANDIDATE_ISSUES_QUERY = `
query MaestroCandidateIssues($projectSlug: String!, $stateNames: [String!], $first: Int!, $after: String) {
  issues(
    first: $first
    after: $after
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $stateNames } }
    }
  ) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}
`;

const ISSUE_STATES_QUERY = `
query MaestroIssueStates($ids: [ID!]) {
  issues(filter: { id: { in: $ids } }) {
    nodes {
      id
      identifier
      title
      state { name }
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

const WORKFLOW_STATE_QUERY = `
query MaestroWorkflowState($name: String!) {
  workflowStates(filter: { name: { eq: $name } }) {
    nodes { id name }
  }
}
`;

const ISSUE_UPDATE_MUTATION = `
mutation MaestroIssueUpdate($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { id identifier state { name } }
  }
}
`;

function timestampOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function labelNames(labels) {
  const nodes = Array.isArray(labels?.nodes) ? labels.nodes : Array.isArray(labels) ? labels : [];
  return nodes
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name) => typeof name === "string" && name)
    .map((name) => name.toLowerCase());
}

function normalizeBlockers(issue) {
  const nodes = Array.isArray(issue?.inverseRelations?.nodes) ? issue.inverseRelations.nodes : [];
  return nodes
    .filter((relation) => String(relation?.type ?? "").toLowerCase() === "blocks")
    .map((relation) => relation.relatedIssue ?? {})
    .map((blockedBy) => ({
      id: blockedBy.id ?? null,
      identifier: blockedBy.identifier ?? null,
      state: blockedBy.state?.name ?? blockedBy.state ?? null,
    }));
}

export function normalizeLinearIssue(issue) {
  return {
    id: issue.id ?? null,
    identifier: issue.identifier ?? null,
    title: issue.title ?? null,
    description: issue.description ?? null,
    priority: intOrNull(issue.priority),
    state: issue.state?.name ?? issue.state ?? null,
    branch_name: issue.branchName ?? issue.branch_name ?? null,
    url: issue.url ?? null,
    labels: labelNames(issue.labels),
    blocked_by: normalizeBlockers(issue),
    created_at: timestampOrNull(issue.createdAt ?? issue.created_at),
    updated_at: timestampOrNull(issue.updatedAt ?? issue.updated_at),
  };
}

export class LinearTrackerClient {
  constructor({
    endpoint = "https://api.linear.app/graphql",
    apiKey,
    projectSlug,
    fetchImpl = fetch,
    pageSize = 50,
    timeoutMs = 30_000,
  }) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.projectSlug = projectSlug;
    this.fetchImpl = fetchImpl;
    this.pageSize = pageSize;
    this.timeoutMs = timeoutMs;
  }

  async graphql(query, variables) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (error) {
      throw trackerError("linear_api_request", error.message, error);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw trackerError("linear_api_status", String(response.status));
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw trackerError("linear_unknown_payload", error.message, error);
    }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw trackerError("linear_graphql_errors", JSON.stringify(payload.errors));
    }
    return payload;
  }

  async fetchCandidateIssues(activeStates) {
    return this.fetchIssuesByStates(activeStates);
  }

  async fetchIssuesByStates(stateNames) {
    if (!Array.isArray(stateNames) || stateNames.length === 0) return [];
    const issues = [];
    let after = null;

    while (true) {
      const payload = await this.graphql(CANDIDATE_ISSUES_QUERY, {
        projectSlug: this.projectSlug,
        stateNames,
        first: this.pageSize,
        after,
      });
      const connection = payload?.data?.issues;
      if (!connection || !Array.isArray(connection.nodes)) {
        throw trackerError("linear_unknown_payload", "missing issues.nodes");
      }
      issues.push(...connection.nodes.map(normalizeLinearIssue));
      if (!connection.pageInfo?.hasNextPage) break;
      after = connection.pageInfo.endCursor;
      if (!after) {
        throw trackerError("linear_missing_end_cursor");
      }
    }

    return issues;
  }

  async fetchIssueStatesByIds(issueIds) {
    if (!Array.isArray(issueIds) || issueIds.length === 0) return [];
    const payload = await this.graphql(ISSUE_STATES_QUERY, { ids: issueIds });
    const nodes = payload?.data?.issues?.nodes;
    if (!Array.isArray(nodes)) {
      throw trackerError("linear_unknown_payload", "missing state refresh nodes");
    }
    return nodes.map(normalizeLinearIssue);
  }

  async transitionIssue(issueId, stateName) {
    if (!issueId || !stateName) return false;
    const lookup = await this.graphql(WORKFLOW_STATE_QUERY, { name: stateName });
    const state = lookup?.data?.workflowStates?.nodes?.[0];
    if (!state?.id) {
      throw trackerError("linear_state_not_found", stateName);
    }
    const payload = await this.graphql(ISSUE_UPDATE_MUTATION, { id: issueId, stateId: state.id });
    if (payload?.data?.issueUpdate?.success !== true) {
      throw trackerError("linear_mutation_error", `issueUpdate ${issueId} → ${stateName}`);
    }
    return true;
  }
}
