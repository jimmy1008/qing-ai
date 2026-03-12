const fs = require("fs");
const path = require("path");

process.env.DEBUG_TELEMETRY = "false";

const { buildContext, generateAIReply } = require("../pipeline");
const memoryStore = require("../../memory/memory_store");

const REPORT_PATH = path.join(__dirname, "../../train/memory_regression_report.json");

function resetMemoryKeys(keys) {
  keys.forEach((key) => {
    memoryStore.memoryMap.delete(key);
  });
}

const fakeClient = {
  async generate({ prompt, system }) {
    const text = String(prompt || "");
    const sys = String(system || "");

    if (
      text.includes("Identity knowledge:\nuser_name:橪")
      && text.includes("Recent conversation:")
      && text.includes("User: 你還記得我是誰嗎？")
      && sys.includes("never explicitly reveal stored identity facts")
    ) {
      return "我當然不是完全陌生啦，但我不想在這裡直接把你的資料喊出來。";
    }

    if (
      text.includes("Recent conversation:")
      && text.includes("user: 我明天要考試")
      && text.includes("User: 你還記得我剛說什麼嗎？")
    ) {
      return "你剛剛說你明天要考試。";
    }

    if (
      text.includes("Identity knowledge:\nuser_name:橪")
      && text.includes("User: 他叫什麼？")
    ) {
      return "我不想直接替別人把這種資訊說出來。";
    }

    if (
      sys.includes("personaMode: developer_private_soft")
      && text.includes("User: 你知道我是誰嗎？")
    ) {
      return "我知道啊，你不用每次都重新報到。";
    }

    if (text.includes("User: 我明天要考試")) {
      return "好，我先記住你明天要考試。";
    }

    if (text.includes("User: 我叫橪")) {
      return "好，我先記住你的名字。";
    }

    return "收到。";
  },
};

async function runPrivateContinuityCase() {
  const event1 = {
    type: "message",
    content: "我明天要考試",
    text: "我明天要考試",
    userId: "memory-private-user",
    connector: "telegram",
    channel: "private",
    isPrivate: true,
    chat: { id: "private-chat-1", type: "private" },
    chatId: "private-chat-1",
  };

  const context1 = buildContext(event1.text, [], { event: event1, userId: event1.userId });
  await generateAIReply(event1.text, context1, fakeClient);

  const event2 = {
    ...event1,
    content: "你還記得我剛說什麼嗎？",
    text: "你還記得我剛說什麼嗎？",
  };
  const context2 = buildContext(event2.text, [], { event: event2, userId: event2.userId });
  const result2 = await generateAIReply(event2.text, context2, fakeClient);

  return {
    passed: result2.reply.includes("考試"),
    reply: result2.reply,
    telemetry: result2.telemetry,
  };
}

async function runGroupIsolationCase() {
  const privateEvent = {
    type: "message",
    content: "我叫橪",
    text: "我叫橪",
    userId: "memory-private-user-2",
    connector: "telegram",
    channel: "private",
    isPrivate: true,
    chat: { id: "private-chat-2", type: "private" },
    chatId: "private-chat-2",
  };

  const privateContext = buildContext(privateEvent.text, [], { event: privateEvent, userId: privateEvent.userId });
  await generateAIReply(privateEvent.text, privateContext, fakeClient);

  const groupEvent = {
    type: "mention",
    content: "他叫什麼？",
    text: "他叫什麼？",
    userId: "group-user-1",
    connector: "telegram",
    channel: "group",
    isPrivate: false,
    isDirectMention: true,
    mentionDetected: true,
    chat: { id: "group-chat-1", type: "supergroup" },
    chatId: "group-chat-1",
  };

  const groupContext = buildContext(groupEvent.text, [], { event: groupEvent, userId: groupEvent.userId });
  const result = await generateAIReply(groupEvent.text, groupContext, fakeClient);

  return {
    passed: !result.reply.includes("橪"),
    reply: result.reply,
    telemetry: result.telemetry,
  };
}

async function runDeveloperRecognitionCase() {
  const devEvent = {
    type: "message",
    content: "你知道我是誰嗎？",
    text: "你知道我是誰嗎？",
    userId: "5686223888",
    connector: "telegram",
    channel: "private",
    isPrivate: true,
    chat: { id: "dev-private-chat", type: "private" },
    chatId: "dev-private-chat",
  };

  const context = buildContext(devEvent.text, [], { event: devEvent, userId: devEvent.userId });
  const result = await generateAIReply(devEvent.text, context, fakeClient);
  const identityMemory = memoryStore.getIdentityMemory(devEvent.userId);
  return {
    passed:
      identityMemory.longTerm.role === "developer"
      && Boolean(identityMemory.longTerm.developerProfile)
      && context.personaModeKey === "developer_private_soft",
    reply: result.reply,
    personaModeKey: context.personaModeKey,
    role: identityMemory.longTerm.role,
    developerProfile: identityMemory.longTerm.developerProfile,
    telemetry: result.telemetry,
  };
}

async function main() {
  resetMemoryKeys([
    "user:memory-private-user",
    "user:memory-private-user-2",
    "group:group-chat-1",
    "identity:memory-private-user",
    "identity:memory-private-user-2",
    "identity:group-user-1",
    "identity:5686223888",
  ]);

  const privateContinuity = await runPrivateContinuityCase();
  const groupIsolation = await runGroupIsolationCase();
  const developerRecognition = await runDeveloperRecognitionCase();

  const report = {
    privateContinuity,
    groupIsolation,
    developerRecognition,
    passed: privateContinuity.passed && groupIsolation.passed && developerRecognition.passed,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log("=== Memory Regression ===");
  console.log("privateContinuity:", privateContinuity.passed);
  console.log("groupIsolation:", groupIsolation.passed);
  console.log("developerRecognition:", developerRecognition.passed);
  console.log("saved:", REPORT_PATH);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
