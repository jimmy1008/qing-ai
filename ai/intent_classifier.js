function classifyIntent(event) {
  if (!event || !event.type) return "none";

  if (event.type === "mention") return "reply";
  if (event.isCommand) return "reply";
  if (event.type === "new_post") return "like";
  if (event.type === "flagged_user") return "block";

  return "none";
}

module.exports = { classifyIntent };
