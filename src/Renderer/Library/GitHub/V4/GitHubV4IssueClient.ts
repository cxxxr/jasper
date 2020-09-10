import {GitHubV4Client} from './GitHubV4Client';
import {
  RemoteGitHubV4IssueEntity,
  RemoteGitHubV4IssueNodesEntity, RemoteGitHubV4Review, RemoteGitHubV4TimelineItemEntity
} from '../../Type/RemoteGitHubV4/RemoteGitHubV4IssueNodesEntity';
import {RemoteIssueEntity} from '../../Type/RemoteGitHubV3/RemoteIssueEntity';
import {ArrayUtil} from '../../Util/ArrayUtil';

export class GitHubV4IssueClient extends GitHubV4Client {
  static injectV4ToV3(v4Issues: RemoteGitHubV4IssueEntity[], v3Issues: RemoteIssueEntity[]) {
    for (const v3Issue of v3Issues) {
      const v4Issue = v4Issues.find(v4Issue => v4Issue.node_id === v3Issue.node_id);
      if (!v4Issue) {
        console.warn(`not found v4Issue. node_id = ${v3Issue.node_id}`);
        continue;
      }

      // 共通
      v3Issue.private = v4Issue.repository.isPrivate;
      v3Issue.involves = v4Issue.participants?.nodes?.map(node => {
        return {
          login: node.login,
          name: node.name,
          avatar_url: node.avatarUrl,
        };
      }) || [];
      v3Issue.last_timeline_user = v4Issue.lastTimelineUser;
      v3Issue.last_timeline_at = v4Issue.lastTimelineAt;
      v3Issue.projects = v4Issue.projectCards?.nodes?.map(node => {
        return {url: node.project.url, name: node.project.name, column: node.column?.name ?? ''};
      }) || [];

      // PRのみ
      if (v4Issue.__typename === 'PullRequest') {
        v3Issue.merged_at = v4Issue.mergedAt;
        v3Issue.draft = v4Issue.isDraft;
        v3Issue.requested_reviewers = v4Issue.reviewRequests?.nodes?.map(node => {
          return {
            login: node.requestedReviewer?.login || node.requestedReviewer?.teamLogin,
            name: node.requestedReviewer?.name || node.requestedReviewer?.teamName,
            avatar_url: node.requestedReviewer?.avatarUrl || node.requestedReviewer?.teamAvatarUrl,
          };
        }) || [];
        v3Issue.reviews = this.getReviewsAtGroupByUser(v4Issue).map(review => {
          return {
            login: review.author.login,
            avatar_url: review.author.avatarUrl,
            state: review.state,
            updated_at: review.updatedAt,
          };
        });
      }

      this.mergeIntoInvolves(v3Issue);
    }
  }

  // ユーザごとの最終reviewを返す。ただし、approveとchanges_requestedをcommentedよりも優先する.
  private static getReviewsAtGroupByUser(v4Issue: RemoteGitHubV4IssueEntity): RemoteGitHubV4Review[] {
    if (!v4Issue.reviews?.nodes?.length) return [];

    const results: RemoteGitHubV4Review[] = [];

    const allReviews = v4Issue.reviews.nodes
      .filter(node => node.author?.login)
      // 最新のreviewを.findできるように並び替えておく
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

    const loginNames = ArrayUtil.unique<string>(allReviews.map(node => node.author?.login));
    for (const loginName of loginNames) {
      const reviews = allReviews.filter(node => node.author.login === loginName);
      const review1 = reviews.find(review => review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED');
      const review2 = reviews.find(review => review.state === 'COMMENTED');
      if (review1 || review2) results.push(review1 || review2);
    }

    return results;
  }

  // v3.involvesは実際はparticipantなので、色々漏れがある。
  // 現在わかっているものは`review-requested`, `mention`
  // todo: `mention`についてはマージできてないのでそのうち対応したい
  private static mergeIntoInvolves(v3Issue: RemoteIssueEntity) {
    // merge requested_reviewers into involves
    for (const reviewer of v3Issue.requested_reviewers) {
      const involves = v3Issue.involves.find(v => v.login === reviewer.login);
      if (involves) continue;
      v3Issue.involves.push({login: reviewer.login, avatar_url: reviewer.avatar_url, name: reviewer.name});
    }
  }

  async getIssuesByNodeIds(nodeIds: string[]): Promise<{error?: Error; issues?: RemoteGitHubV4IssueEntity[]}> {
    const validNodesIds = nodeIds.filter(nodeId => nodeId);
    const allIssues: RemoteGitHubV4IssueEntity[] = [];
    const slice = 25;
    const promises: Promise<{error?: Error; issues?: RemoteGitHubV4IssueEntity[]}>[] = [];
    for (let i = 0; i < validNodesIds.length; i += slice) {
      const p = this.getIssuesByNodeIdsInternal(validNodesIds.slice(i, i + slice));
      promises.push(p);
    }

    const results = await Promise.all(promises);
    const error = results.find(res => res.error)?.error;
    if (error) return {error};

    results.forEach(res => allIssues.push(...res.issues));

    return {issues: allIssues};
  }

  private async getIssuesByNodeIdsInternal(nodeIds: string[]): Promise<{error?: Error; issues?: RemoteGitHubV4IssueEntity[]}> {
    const joinedNodeIds = nodeIds.map(nodeId => `"${nodeId}"`).join(',');
    const query = this.getQueryTemplate().replace(`__NODE_IDS__`, joinedNodeIds);
    const {error, data} = await this.request<RemoteGitHubV4IssueNodesEntity>(query);
    if (error) return {error};

    const issues = data.nodes;

    // inject last timeline
    for (const issue of issues) {
      const {timelineUser, timelineAt} = this.getLastTimelineInfo(issue);
      issue.lastTimelineUser = timelineUser;
      issue.lastTimelineAt = timelineAt;
    }

    return {issues};
  }

  // 古いGHEでは使えいない型を除外する
  private getQueryTemplate(): string {
    if (this.isGitHubCom) return QUERY_TEMPLATE;

    // gheVersion format = `2.19.5`
    const tmp = this.gheVersion.split('.');
    const major = parseInt(tmp[0], 10);
    const minor = parseInt(tmp[1], 10);

    if (major >= 3) return QUERY_TEMPLATE;

    const notAvailableTypeNames: string[] = [];

    // v2.20以下では使用できない
    if (minor <= 20) {
      notAvailableTypeNames.push(
        'ConnectedEvent',
        'DisconnectedEvent',
        'UnmarkedAsDuplicateEvent',
        'ConvertToDraftEvent',
        'isDraft',
      );
    }

    // 現時点(2020-09-06)での最新(v2.21)でも使用できない
    if (minor <= 21) {
      notAvailableTypeNames.push(
        'AutomaticBaseChangeFailedEvent',
        'AutomaticBaseChangeSucceededEvent',
      );
    }

    let safeQueryTemplate: string = QUERY_TEMPLATE;
    for (const notAvailableTypeName of notAvailableTypeNames) {
      safeQueryTemplate = safeQueryTemplate.replace(new RegExp(`.*${notAvailableTypeName}.*`, 'g'), '');
    }

    return safeQueryTemplate;
  }

  private getLastTimelineInfo(issue: RemoteGitHubV4IssueEntity): {timelineUser: string, timelineAt: string} {
    // timelineがない == descしかない == 新規issue
    if (!issue.timelineItems?.nodes?.length) {
      return {timelineUser: issue.author.login, timelineAt: issue.updatedAt};
    }

    const timelineItems = [...issue.timelineItems.nodes];
    timelineItems.sort((timeline1, timeline2) => {
      const {timelineAt: timelineAt1} = this.getTimelineInfo(timeline1);
      const {timelineAt: timelineAt2} = this.getTimelineInfo(timeline2);
      return new Date(timelineAt2).getTime() - new Date(timelineAt1).getTime();
    });

    const timelineItem = timelineItems[0];
    const {timelineUser, timelineAt} = this.getTimelineInfo(timelineItem);

    // PRを出した直後は、timelineのPullRequestCommit(pushedDate)はissue.updatedAtよりも古い
    // なのでPullRequestCommit(pushedDate)ではなく、issue.updated_atを使う
    if (timelineItem.__typename === 'PullRequestCommit' && timelineAt < issue.updatedAt) {
      return {timelineUser: issue.author?.login, timelineAt: issue.updatedAt};
    } else {
      return {timelineUser, timelineAt};
    }
  }

  private getTimelineInfo(timelineItem: RemoteGitHubV4TimelineItemEntity): {timelineUser: string; timelineAt: string} {
    const timelineUser = timelineItem.actor?.login
      || timelineItem.editor?.login
      || timelineItem.author?.login
      || timelineItem.commit?.author?.user?.login
      || timelineItem.comments?.nodes?.[0]?.editor?.login
      || timelineItem.comments?.nodes?.[0]?.author?.login
      || timelineItem.lastSeenCommit?.author?.user?.login
      || '';

    const timelineAt = timelineItem.updatedAt
      || timelineItem.createdAt
      || timelineItem.commit?.pushedDate
      || timelineItem.comments?.nodes?.[0]?.updatedAt
      || timelineItem.comments?.nodes?.[0]?.createdAt
      || timelineItem.lastSeenCommit?.pushedDate
      || '';

    return {timelineUser, timelineAt};
  }
}

const COMMON_QUERY_TEMPLATE = `
  __typename
  updatedAt
  author {
    login
  }
  number
  repository {
    nameWithOwner
    isPrivate
  }      
  participants(first: 100) {
    nodes {
      login
      avatarUrl
      name
    }
  }
  projectCards(first: 100) {
    nodes {
      project {
        url
        name
      }
      column {
        name
      }
    }
  }
`;

const ISSUE_TIMELINE_ITEMS = `
# https://docs.github.com/en/graphql/reference/unions#issuetimelineitems
... on AddedToProjectEvent {__typename createdAt actor {login}}
... on AssignedEvent {__typename createdAt actor {login}}
... on ClosedEvent {__typename createdAt actor {login}}
... on CommentDeletedEvent {__typename createdAt actor {login}}
... on ConnectedEvent {__typename createdAt actor {login}}
... on ConvertedNoteToIssueEvent {__typename createdAt actor {login}}
... on CrossReferencedEvent {__typename createdAt actor {login}}
... on DemilestonedEvent {__typename createdAt actor {login}}
... on DisconnectedEvent {__typename createdAt actor {login}}
# not actor
... on IssueComment {__typename createdAt updatedAt author {login} editor {login}}
... on LabeledEvent {__typename createdAt actor {login}}
... on LockedEvent {__typename createdAt actor {login}}
... on MarkedAsDuplicateEvent {__typename createdAt actor {login}}
... on MentionedEvent {__typename createdAt actor {login}}
... on MilestonedEvent {__typename createdAt actor {login}}
... on MovedColumnsInProjectEvent {__typename createdAt actor {login}}
... on PinnedEvent {__typename createdAt actor {login}}
... on ReferencedEvent {__typename createdAt actor {login}}
... on RemovedFromProjectEvent {__typename createdAt actor {login}}
... on RenamedTitleEvent {__typename createdAt actor {login}}
... on ReopenedEvent {__typename createdAt actor {login}}
... on SubscribedEvent {__typename createdAt actor {login}}
... on TransferredEvent {__typename createdAt actor {login}}
... on UnassignedEvent {__typename createdAt actor {login}}
... on UnlabeledEvent {__typename createdAt actor {login}}
... on UnlockedEvent {__typename createdAt actor {login}}
... on UnmarkedAsDuplicateEvent {__typename createdAt actor {login}}
... on UnpinnedEvent {__typename createdAt actor {login}}
... on UnsubscribedEvent {__typename createdAt actor {login}}
... on UserBlockedEvent {__typename createdAt actor {login}}
`;

const PULL_REQUEST_TIMELINE_ITEMS = `
# https://docs.github.com/en/graphql/reference/unions#pullrequesttimelineitems
... on AddedToProjectEvent {__typename createdAt actor {login}}
... on AssignedEvent {__typename createdAt actor {login}}
... on AutomaticBaseChangeFailedEvent {__typename createdAt actor {login}}
... on AutomaticBaseChangeSucceededEvent {__typename createdAt actor {login}}
... on BaseRefChangedEvent {__typename createdAt actor {login}}
... on BaseRefForcePushedEvent {__typename createdAt actor {login}}
... on ClosedEvent {__typename createdAt actor {login}}
... on CommentDeletedEvent {__typename createdAt actor {login}}
... on ConnectedEvent {__typename createdAt actor {login}}
... on ConvertToDraftEvent {__typename createdAt actor {login}}
... on ConvertedNoteToIssueEvent {__typename createdAt actor {login}}
... on CrossReferencedEvent {__typename createdAt actor {login}}
... on DemilestonedEvent {__typename createdAt actor {login}}
... on DeployedEvent {__typename createdAt actor {login}}
... on DeploymentEnvironmentChangedEvent {__typename createdAt actor {login}}
... on DisconnectedEvent {__typename createdAt actor {login}}
... on HeadRefDeletedEvent {__typename createdAt actor {login}}
... on HeadRefForcePushedEvent {__typename createdAt actor {login}}
... on HeadRefRestoredEvent {__typename createdAt actor {login}}
# not actor
... on IssueComment {__typename createdAt updatedAt author {login} editor{login}}
... on LabeledEvent {__typename createdAt actor {login}}
... on LockedEvent {__typename createdAt actor {login}}
... on MarkedAsDuplicateEvent {__typename createdAt actor {login}}
... on MentionedEvent {__typename createdAt actor {login}}
... on MergedEvent {__typename createdAt actor {login}}
... on MilestonedEvent {__typename createdAt actor {login}}
... on MovedColumnsInProjectEvent {__typename createdAt actor {login}}
... on PinnedEvent {__typename createdAt actor {login}}
# not actor
... on PullRequestCommit {__typename commit {pushedDate author {user {login}}}}
# not actor
... on PullRequestCommitCommentThread {__typename comments(last: 1) {nodes {createdAt updatedAt editor {login}}}}
# not actor
... on PullRequestReview {__typename createdAt updatedAt author {login} editor {login}}
# not actor
... on PullRequestReviewThread {__typename comments(last: 1) {nodes {createdAt updatedAt author {login} editor {login}}}}
# not actor
... on PullRequestRevisionMarker {__typename  lastSeenCommit {pushedDate author {user {login}}}}
... on ReadyForReviewEvent {__typename createdAt actor {login}}
... on ReferencedEvent {__typename createdAt actor {login}}
... on RemovedFromProjectEvent {__typename createdAt actor {login}}
... on RenamedTitleEvent {__typename createdAt actor {login}}
... on ReopenedEvent {__typename createdAt actor {login}}
... on ReviewDismissedEvent {__typename createdAt actor {login}}
... on ReviewRequestRemovedEvent {__typename createdAt actor {login}}
... on ReviewRequestedEvent {__typename createdAt actor {login}}
... on SubscribedEvent {__typename createdAt actor {login}}
... on TransferredEvent {__typename createdAt actor {login}}
... on UnassignedEvent {__typename createdAt actor {login}}
... on UnlabeledEvent {__typename createdAt actor {login}}
... on UnlockedEvent {__typename createdAt actor {login}}
... on UnmarkedAsDuplicateEvent {__typename createdAt actor {login}}
... on UnpinnedEvent {__typename createdAt actor {login}}
... on UnsubscribedEvent {__typename createdAt actor {login}}
... on UserBlockedEvent {__typename createdAt actor {login}}
`;

const QUERY_TEMPLATE = `
nodes(ids: [__NODE_IDS__]) {
  node_id: id

  ... on Issue {
    ${COMMON_QUERY_TEMPLATE}
    timelineItems(last: 100) {
      nodes {
        __typename
        ${ISSUE_TIMELINE_ITEMS}
      }
    }
  }
  
  ... on PullRequest {
    ${COMMON_QUERY_TEMPLATE}
    isDraft
    mergedAt
    reviewRequests(first:100) {
      nodes {
        requestedReviewer {
          ... on  User {
            login
            avatarUrl
            name
          }
          ... on Team {
            teamLogin: combinedSlug
            teamName: name
            teamAvatarUrl: avatarUrl
          }
        }
      }
    }
    reviews(first: 100) {
      nodes {
        author {
          login
          avatarUrl
        }
        state
        updatedAt
      }
    }
    timelineItems(last: 100) {
      nodes {
        __typename
        ${PULL_REQUEST_TIMELINE_ITEMS}
      }
    }
  }
}
`;
