import * as github from '@actions/github'
import {GitHub} from "@actions/github/lib/utils";
import {context} from '@actions/github'
import * as core from '@actions/core'
import {SnapshotDifference} from './snapshots'
import fileSize from 'filesize'
import table from 'text-table'
import {shouldIncludeInDiff} from "./utils"

export function githubClient(): InstanceType<typeof GitHub> {
  const token = core.getInput('token')
  return github.getOctokit(token)
}

async function postNewComment(message: string): Promise<void> {
  const client = githubClient()
  await client.issues.createComment({
    body: message,
    issue_number: context.issue.number,
    owner: context.issue.owner,
    repo: context.issue.repo
  })
}

async function updateComment(
  message: string,
  comment_id: number
): Promise<void> {
  const client = githubClient()

  await client.issues.updateComment({
    body: message,
    comment_id,
    owner: context.issue.owner,
    repo: context.issue.repo
  })
}

export async function createOrUpdateComment(
  toolchain: string,
  message: string
): Promise<void> {
  core.info(`Find comments for issue: ${github.context.issue.number}`)
  const client = githubClient()

  const comments = await client.issues.listComments({
    owner: context.issue.owner,
    repo: context.issue.repo,
    issue_number: context.issue.number,
    per_page: 100
  })

  if (comments.status != 200) {
    return core.setFailed(
      `Error fetching comments for MR ${github.context.issue.number}`
    )
  }
  core.info(
    `Found ${comments.data.length} comments. Searching for comments containing ${toolchain}`
  )

  const ourComments = comments.data.filter(v => {
    // Is there a better way to do this?
    return v.user.login == 'github-actions[bot]' && v.body.includes(toolchain)
  })

  if (!ourComments.length) {
    core.info('No existing comment found, creating a new comment')
    await postNewComment(message)
  } else {
    // Update the first comment
    const id = ourComments[0].id
    core.info(`Updating comment with ID ${id}`)
    await updateComment(message, id)
  }
}

export function createSnapshotComment(
  diff: SnapshotDifference
): string {
  const crateTableRows: Array<[string, string]> = []
  diff.crateDifference.forEach(d => {
    if (d.old === null && d.new === null) {
      return
    }
    if (d.old === d.new) {
      crateTableRows.push([`${d.name}`, fileSize(d.new as number)])
    } else {
      if (d.old) {
        crateTableRows.push([`- ${d.name}`, fileSize(d.old)])
      }
      if (d.new) {
        crateTableRows.push([`+ ${d.name}`, fileSize(d.new)])
      }
    }
  })

  const sizeTableRows: Array<[string, string, string]> = []
  if (shouldIncludeInDiff(diff.currentSize, diff.oldSize)) {
    sizeTableRows.push(['- Size', fileSize(diff.oldSize), ''])
    sizeTableRows.push([
      '+ Size',
      `${fileSize(diff.currentSize)}`,
      `${diff.sizeDifference > 0 ? '+' : ''}${fileSize(diff.sizeDifference)}`
    ])
  } else {
    sizeTableRows.push(['Size', fileSize(diff.currentTextSize), ''])
  }

  if (shouldIncludeInDiff(diff.currentTextSize, diff.oldTextSize)) {
    sizeTableRows.push(['- Text Size', fileSize(diff.oldTextSize), ''])
    sizeTableRows.push([
      '+ Text Size',
      `${fileSize(diff.currentTextSize)}`,
      `${diff.textDifference > 0 ? '+' : ''}${fileSize(diff.textDifference)}`
    ])
  } else {
    sizeTableRows.push(['Text size', fileSize(diff.currentTextSize), ''])
  }

  const crateTable = table(crateTableRows)

  const sizeTable = table(sizeTableRows)


  let treeDiff

  if (typeof diff.treeDiff === 'string') {
    treeDiff = diff.treeDiff
  } else {
    const treeDiffLines: Array<string> = []

    diff.treeDiff.forEach(change => {
      let prefix = " "
      if (change.added) {
        prefix = "+"
      } else if (change.removed) {
        prefix = "-"
      }
      const splitLines = change.value.split("\n")
      treeDiffLines.push(splitLines.slice(0, -1).map(line=>`${prefix} ${line}`).join("\n") + "\n")
    })

    treeDiff = treeDiffLines.join('') + '\n'
  }

  let dependencyCountDiff
  if (diff.oldDependenciesCount == diff.newDependenciesCount) {
    dependencyCountDiff = `Count: ${diff.oldDependenciesCount}`
  } else {
    dependencyCountDiff = `- Count: ${diff.oldDependenciesCount}\n`
    dependencyCountDiff += `+ Count: ${diff.newDependenciesCount}`
  }

  const crateDetailsText =
    crateTableRows.length == 0
      ? 'No changes to crate sizes'
      : `
<details>
<summary>Size difference per crate</summary>
<br />

**Note:** The numbers below are not 100% accurate, use them as a rough estimate.

\`\`\`diff
@@ Breakdown per crate @@

${crateTable}
\`\`\`

</details>
`
  const treeDiffText = `
<details>
<summary>Dependency tree</summary>
<br />

\`\`\`diff
@@ Dependency tree @@
${dependencyCountDiff}

${treeDiff}
\`\`\`

</details>
`

  return `
\`\`\`diff
@@ Size breakdown @@

${sizeTable}

\`\`\`

${crateDetailsText}

${treeDiffText}
`
}

export function createComment(masterCommit: string | null, currentCommit: string,
                              toolchain: string,
                              snapshots: SnapshotDifference[]): string {
  const emojiList = {
    apple: 'apple',
    windows: 'office',
    arm: 'muscle',
    linux: 'cowboy_hat_face' // Why not?
  }

  let selectedEmoji = 'crab'

  for (const [key, emoji] of Object.entries(emojiList)) {
    if (toolchain.includes(key)) {
      selectedEmoji = emoji
      break
    }
  }

  const compareCommitText =
    masterCommit == null
      ? ''
      : `([Compare with baseline commit](https://gitea.izzys.place/${context.repo.owner}/${context.repo.repo}/compare/${masterCommit}..${currentCommit}))`

  let innerComment

  if (snapshots.length == 1) {
    innerComment = createSnapshotComment(snapshots[0])
  } else {
    innerComment = snapshots.map(snapshot => {
      const comment = createSnapshotComment(snapshot)
      return `<details>
<summary><strong>${snapshot.packageName}</strong>${shouldIncludeInDiff(snapshot.currentSize, snapshot.oldSize) ? " (Changes :warning:)" : ""}</summary>
<br />
${comment}
</details>`
    }).join('\n')
  }


  return `
  :${selectedEmoji}: Cargo bloat for toolchain **${toolchain}** :${selectedEmoji}:

  ${innerComment}

  Commit: ${currentCommit} ${compareCommitText}
  `
}
