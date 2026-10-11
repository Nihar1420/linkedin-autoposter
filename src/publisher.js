export const CHECK_EVERY_MS = 30_000;

/**
 * Publishes one post. It's claimed first, so an overlapping run can't send it
 * twice. A post that fails stays "failed" until you retry it: if the connection
 * dropped mid-request it may have gone through, so retrying automatically
 * could post it twice.
 */
export async function publishPost({ store, linkedin, dryRun }, id, fromStatuses) {
  if (!store.claimForPublishing(id, fromStatuses)) return false;

  try {
    let urn = `dry-run:${id}`;
    if (!dryRun) {
      const post = store.getPost(id);
      const account = store.getAccount(post.account_id);
      if (!account?.accessToken) throw new Error("LinkedIn isn't connected for this account.");
      if (Date.parse(account.expiresAt) <= Date.now()) {
        throw new Error("Your LinkedIn connection has expired. Reconnect and try again.");
      }
      urn = await linkedin.createPost({
        accessToken: account.accessToken,
        personUrn: account.personUrn,
        text: post.body,
      });
    }
    store.markPublished(id, urn);
  } catch (err) {
    store.markFailed(id, err.message);
    console.error(`Post ${id} failed: ${err.message}`);
  }
  return true;
}

export async function publishDuePosts(deps, now = new Date()) {
  for (const id of deps.store.duePostIds(now.toISOString())) {
    await publishPost(deps, id, ["scheduled"]);
  }
}

export function startPublisher(deps) {
  const run = () => publishDuePosts(deps).catch((err) => console.error("Publisher error:", err));
  run();
  return setInterval(run, CHECK_EVERY_MS);
}
