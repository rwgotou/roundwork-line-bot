const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ===== GASのWebアプリURLに置き換える =====
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbxkmNffJmVgALmvM1pjeTz72itaqU6kEuEzJKCwE8gN3liafEzF8i-1G2dHRdPMx7Kyxg/exec";

// コース一覧
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

const DELAY_TIMES = ["0.5h", "1h", "1.5h", "2h", "2.5h", "3h"];
const DELAY_REASONS = ["渋滞", "トラブル", "事故", "体調不良"];
const INJURY_OPTIONS = ["けがあり", "けがなし"];
const DRIVABLE_OPTIONS = ["自走可能", "自走不可"];
const BUSINESS_TYPES = ["配送遅延", "交通事故", "その他"];

// ユーザーごとの一時状態
const userStates = {};

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
  const userId = event.source.userId || "";

  if (!userId) return;

  // キャンセル
  if (text === "キャンセル") {
    delete userStates[userId];
    return replyText(replyToken, "操作をキャンセルしました。");
  }

  // 出発報告スタート
  if (text === "出発報告") {
    userStates[userId] = {
      flow: "departure",
      step: "course",
    };
    return replyQuickReply(replyToken, "出発するコースを選択してください", COURSES);
  }

  // 終了報告スタート
  if (text === "終了報告") {
    userStates[userId] = {
      flow: "finish",
      step: "course",
    };
    return replyQuickReply(replyToken, "終了したコースを選択してください", COURSES);
  }

  // 業務連絡スタート
  if (text === "業務連絡") {
    userStates[userId] = {
      flow: "business",
      step: "type",
    };
    return replyQuickReply(replyToken, "業務連絡の種類を選択してください", BUSINESS_TYPES);
  }

  const state = userStates[userId];

  if (!state) {
    return replyText(
      replyToken,
      "リッチメニューの「出発報告」「終了報告」「業務連絡」から選択してください。"
    );
  }

  // =========================
  // 出発報告
  // =========================
  if (state.flow === "departure") {
    if (state.step === "course") {
      if (!COURSES.includes(text)) {
        return replyQuickReply(replyToken, "出発するコースを選択してください", COURSES);
      }

      state.course = text;
      state.step = "health";
      state.healthOk = false;
      state.alcoholOk = false;

      return replyQuickReply(
        replyToken,
        `出発点呼を確認してください\nコース: ${state.course}`,
        ["体調良好", "アルコールなし", "問題あり"]
      );
    }

    if (state.step === "health") {
      if (text === "問題あり") {
        const logMessage = `問題あり`;
        await sendLog(userId, "出発点呼異常", state.course || "", logMessage);

        delete userStates[userId];
        return replyText(
          replyToken,
          `出発点呼で「問題あり」を受け付けました。\n管理者へ直接連絡してください。`
        );
      }

      if (text === "体調良好") {
        state.healthOk = true;
      }

      if (text === "アルコールなし") {
        state.alcoholOk = true;
      }

      if (state.healthOk && state.alcoholOk) {
        const doneMessage =
          `出発｜${state.course}\n` +
          `体調良好・アルコールなし を受け付けました。\n` +
          `今日も安全運転でお願いします。`;

        await sendLog(
          userId,
          "出発",
          state.course,
          "体調良好・アルコールなし"
        );

        delete userStates[userId];
        return replyText(replyToken, doneMessage);
      }

      const remain = [];
      if (!state.healthOk) remain.push("体調良好");
      if (!state.alcoholOk) remain.push("アルコールなし");

      return replyQuickReply(
        replyToken,
        `未確認項目があります。\n残り: ${remain.join(" / ")}`,
        [...remain, "問題あり"]
      );
    }
  }

  // =========================
  // 終了報告
  // =========================
  if (state.flow === "finish") {
    if (state.step === "course") {
      if (!COURSES.includes(text)) {
        return replyQuickReply(replyToken, "終了したコースを選択してください", COURSES);
      }

      const doneMessage = `終了｜${text} を受け付けました。\n本日もお疲れさまでした。`;

      await sendLog(
        userId,
        "終了",
        text,
        "終了受付"
      );

      delete userStates[userId];
      return replyText(replyToken, doneMessage);
    }
  }

  // =========================
  // 業務連絡
  // =========================
  if (state.flow === "business") {
    if (state.step === "type") {
      if (!BUSINESS_TYPES.includes(text)) {
        return replyQuickReply(replyToken, "業務連絡の種類を選択してください", BUSINESS_TYPES);
      }

      state.type = text;

      if (text === "配送遅延") {
        state.step = "delay_course";
        return replyQuickReply(replyToken, "遅延しているコースを選択してください", COURSES);
      }

      if (text === "交通事故") {
        state.step = "accident_course";
        return replyQuickReply(replyToken, "事故が発生したコースを選択してください", COURSES);
      }

      if (text === "その他") {
        state.step = "other_message";
        return replyText(replyToken, "内容を入力してください。");
      }
    }

    // 配送遅延
    if (state.step === "delay_course") {
      if (!COURSES.includes(text)) {
        return replyQuickReply(replyToken, "遅延しているコースを選択してください", COURSES);
      }

      state.course = text;
      state.step = "delay_time";
      return replyQuickReply(replyToken, "遅延時間を選択してください", DELAY_TIMES);
    }

    if (state.step === "delay_time") {
      if (!DELAY_TIMES.includes(text)) {
        return replyQuickReply(replyToken, "遅延時間を選択してください", DELAY_TIMES);
      }

      state.delayTime = text;
      state.step = "delay_reason";
      return replyQuickReply(replyToken, "遅延原因を選択してください", DELAY_REASONS);
    }

    if (state.step === "delay_reason") {
      if (!DELAY_REASONS.includes(text)) {
        return replyQuickReply(replyToken, "遅延原因を選択してください", DELAY_REASONS);
      }

      const doneMessage =
        `業務連絡｜配送遅延\n` +
        `コース: ${state.course}\n` +
        `遅延時間: ${state.delayTime}\n` +
        `原因: ${text}`;

      await sendLog(
        userId,
        "配送遅延",
        state.course,
        `遅延時間: ${state.delayTime} / 原因: ${text}`
      );

      delete userStates[userId];
      return replyText(replyToken, doneMessage);
    }

    // 交通事故
    if (state.step === "accident_course") {
      if (!COURSES.includes(text)) {
        return replyQuickReply(replyToken, "事故が発生したコースを選択してください", COURSES);
      }

      state.course = text;
      state.step = "accident_injury";
      return replyQuickReply(replyToken, "けがの有無を選択してください", INJURY_OPTIONS);
    }

    if (state.step === "accident_injury") {
      if (!INJURY_OPTIONS.includes(text)) {
        return replyQuickReply(replyToken, "けがの有無を選択してください", INJURY_OPTIONS);
      }

      state.injury = text;
      state.step = "accident_drivable";
      return replyQuickReply(replyToken, "車両の自走可否を選択してください", DRIVABLE_OPTIONS);
    }

    if (state.step === "accident_drivable") {
      if (!DRIVABLE_OPTIONS.includes(text)) {
        return replyQuickReply(replyToken, "車両の自走可否を選択してください", DRIVABLE_OPTIONS);
      }

      state.drivable = text;
      state.step = "accident_detail";
      return replyText(replyToken, "事故の状況を入力してください。");
    }

    if (state.step === "accident_detail") {
      const detail = text;

      const doneMessage =
        `業務連絡｜交通事故\n` +
        `コース: ${state.course}\n` +
        `けが: ${state.injury}\n` +
        `車両: ${state.drivable}\n` +
        `状況: ${detail}`;

      await sendLog(
        userId,
        "交通事故",
        state.course,
        `けが: ${state.injury} / 車両: ${state.drivable} / 状況: ${detail}`
      );

      delete userStates[userId];
      return replyText(replyToken, doneMessage);
    }

    // その他
    if (state.step === "other_message") {
      const detail = text;

      const doneMessage =
        `業務連絡｜その他\n` +
        `内容: ${detail}`;

      await sendLog(
        userId,
        "その他",
        "",
        detail
      );

      delete userStates[userId];
      return replyText(replyToken, doneMessage);
    }
  }

  return replyText(replyToken, "もう一度、リッチメニューから操作してください。");
}

async function sendLog(userId, type, course, message) {
  if (!GAS_WEB_APP_URL || GAS_WEB_APP_URL === "YOUR_GAS_WEB_APP_URL") {
    console.log("GAS_WEB_APP_URL が未設定のためログ送信をスキップしました。");
    return;
  }

  try {
    await axios.post(GAS_WEB_APP_URL, {
      userId,
      type,
      course,
      message,
    });
  } catch (error) {
    console.error("ログ送信エラー:", error.message);
  }
}

async function replyText(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [
      {
        type: "text",
        text,
      },
    ],
  });
}

async function replyQuickReply(replyToken, promptText, labels) {
  const items = labels.map((label) => ({
    type: "action",
    action: {
      type: "message",
      label,
      text: label,
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