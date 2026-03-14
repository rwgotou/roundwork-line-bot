const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const COURSES = [
  "保A",
  "保B",
  "保C",
  "保E",
  "丸大E",
  "丸大L",
  "チーズ",
  "IH2",
  "IH10",
  "IH13",
  "焼き鳥",
  "うどん",
];

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("ERROR");
  }
});

async function handleEvent(event) {
  if (event.type !== "message") return;
  if (!event.message || event.message.type !== "text") return;

  const text = (event.message.text || "").trim();
  const replyToken = event.replyToken;

  if (text === "出発報告") {
    return replyCourseQuickReply(replyToken, "出発するコースを選択してください", "出発");
  }

  if (text === "終了報告") {
    return replyCourseQuickReply(replyToken, "終了したコースを選択してください", "終了");
  }

  if (text.startsWith("出発｜")) {
    const course = text.replace("出発｜", "");
    return client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: `出発｜${course} を受け付けました。今日も安全運転でお願いします。`,
        },
      ],
    });
  }

  if (text.startsWith("終了｜")) {
    const course = text.replace("終了｜", "");
    return client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: `終了｜${course} を受け付けました。本日もお疲れさまでした。`,
        },
      ],
    });
  }

  return client.replyMessage({
    replyToken,
    messages: [
      {
        type: "text",
        text: "リッチメニューの「出発報告」または「終了報告」を押してください。",
      },
    ],
  });
}

async function replyCourseQuickReply(replyToken, promptText, mode) {
  const items = COURSES.map((course) => ({
    type: "action",
    action: {
      type: "message",
      label: course,
      text: `${mode}｜${course}`,
    },
  }));

  return client.replyMessage({
    replyToken,
    messages: [
      {
        type: "text",
        text: promptText,
        quickReply: {
          items,
        },
      },
    ],
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});