const { scheduler } = require("../../core/priority_scheduler");
const { emitIncomingEvent } = require("../../core/event_bus");
const { processNextAction } = require("../action_planner");

async function main() {
  scheduler.reset();

  const orderingEvents = [
    { connector: "threads", platform: "threads", type: "new_post", postId: "feed-1", content: "feed item" },
    { connector: "threads", platform: "threads", type: "comment", postId: "comment-1", postAuthorId: "self-1", content: "own post comment" },
    { connector: "telegram", platform: "telegram", type: "dm", channel: "private", userId: "user-1", content: "dm text" },
  ];

  orderingEvents.forEach((event) => {
    emitIncomingEvent(event, { selfId: "self-1", skipCooldown: true });
  });

  const order = [];
  for (let i = 0; i < 3; i += 1) {
    const result = await processNextAction(async (item) => {
      order.push(item.type);
      return { executed: true, mocked: true, type: item.type };
    });
    if (!result?.processed) break;
  }

  scheduler.reset();
  const cooldownItem = emitIncomingEvent(
    {
      connector: "threads",
      platform: "threads",
      type: "new_post",
      postId: "feed-cooldown",
      content: "feed cooldown test",
    },
    { selfId: "self-1" },
  );

  const cooldownReadyImmediately = scheduler.hasPending(cooldownItem.timestamp);

  const report = {
    expectedOrder: ["NEW_DM", "NEW_COMMENT_ON_OWN_POST", "NEW_POST_IN_FEED"],
    actualOrder: order,
    orderingPass: JSON.stringify(order) === JSON.stringify(["NEW_DM", "NEW_COMMENT_ON_OWN_POST", "NEW_POST_IN_FEED"]),
    cooldown: {
      type: cooldownItem?.type || null,
      cooldownMs: cooldownItem?.cooldownMs || 0,
      nextAvailableAt: cooldownItem?.nextAvailableAt || null,
      readyImmediately: cooldownReadyImmediately,
      obeysCooldown: Number(cooldownItem?.nextAvailableAt || 0) > Number(cooldownItem?.timestamp || 0),
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
